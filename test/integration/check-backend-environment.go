// Read-only connectivity/schema checks. No migrations, seed data, wallet changes,
// Redis writes or ES index creation. Config credentials never enter the report.
package main

import (
	"app/config"
	"app/esindex"
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	mysql "github.com/go-sql-driver/mysql"
	"github.com/redis/go-redis/v9"
	"gopkg.in/yaml.v2"
)

type check struct {
	Name    string   `json:"name"`
	OK      bool     `json:"ok"`
	Detail  string   `json:"detail"`
	Missing []string `json:"missing,omitempty"`
}

type quietRedisLog struct{}

func (quietRedisLog) Printf(context.Context, string, ...interface{}) {}

func main() {
	redis.SetLogger(quietRedisLog{})
	file := flag.String("config", "", "existing backend YAML file")
	output := flag.String("output", "", "sanitized report path")
	flag.Parse()
	raw, err := os.ReadFile(*file)
	if err != nil {
		fmt.Println("Configuration could not be read")
		os.Exit(2)
	}
	var cfg config.RunConfig
	if yaml.Unmarshal(raw, &cfg) != nil {
		fmt.Println("Configuration is invalid")
		os.Exit(2)
	}
	var lock sync.Mutex
	results := []check{}
	add := func(value check) { lock.Lock(); results = append(results, value); lock.Unlock() }
	var tasks sync.WaitGroup
	for _, role := range []string{"manager", "player"} {
		tasks.Add(1)
		go func(role string) {
			defer tasks.Done()
			target := map[string]string{"manager": "go_manager", "player": "go_player"}[role]
			c, ok := cfg.Mysql[role]
			if !ok {
				add(check{Name: "mysql." + role, Detail: "connection not configured"})
				return
			}
			opts := mysql.NewConfig()
			opts.User = c.User
			opts.Passwd = c.Password
			opts.Net = "tcp"
			opts.Addr = net.JoinHostPort(c.Host, fmt.Sprint(c.Port))
			opts.Timeout = 3 * time.Second
			opts.ReadTimeout = 3 * time.Second
			opts.WriteTimeout = 3 * time.Second
			db, e := sql.Open("mysql", opts.FormatDSN())
			if e != nil {
				add(check{Name: "mysql." + role, Detail: "connection setup failed"})
				return
			}
			defer db.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if e = db.PingContext(ctx); e != nil {
				add(check{Name: "mysql." + role, Detail: "connection or authentication unavailable"})
				return
			}
			var count int
			if e = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name=?", target).Scan(&count); e != nil {
				add(check{Name: "mysql." + role, Detail: "schema metadata unavailable"})
				return
			}
			if count != 1 {
				add(check{Name: "mysql." + role, Detail: target + " does not exist or is not visible"})
				return
			}
			required := []string{"gg_match", "gg_match_runtime", "gg_match_schedule", "gg_blinds", "gg_ticket", "gg_fair_proof", "gg_smart_task", "gp_game"}
			if role == "player" {
				required = []string{"user_info", "gg_ticket_hold", "gg_player_panel_hand"}
			}
			missing := []string{}
			for _, table := range required {
				if e = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=? AND table_name=?", target, table).Scan(&count); e != nil || count != 1 {
					missing = append(missing, table)
				}
			}
			add(check{Name: "mysql." + role, OK: len(missing) == 0, Detail: target + " schema inspected", Missing: missing})
		}(role)
	}
	tasks.Add(1)
	go func() {
		defer tasks.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		client := redis.NewUniversalClient(&redis.UniversalOptions{Addrs: cfg.Redis.Host, Username: cfg.Redis.User, Password: cfg.Redis.Pwd, DialTimeout: 2 * time.Second, ReadTimeout: 2 * time.Second, WriteTimeout: 2 * time.Second, MaxRetries: -1})
		defer client.Close()
		if e := client.Ping(ctx).Err(); e != nil {
			add(check{Name: "redis.ping", Detail: "connection or authentication unavailable"})
			return
		}
		add(check{Name: "redis.ping", OK: true, Detail: "authenticated PING succeeded"})
		// Check the actual required keys, rather than drawing a conclusion from
		// SCAN's first page. GET routes correctly on both standalone and cluster.
		missing := []string{}
		for _, key := range []string{esindex.ConfigKey("system"), esindex.ConfigKey("currency")} {
			value, e := client.Get(ctx, key).Result()
			if e == redis.Nil {
				missing = append(missing, key)
				continue
			}
			if e != nil {
				add(check{Name: "redis.prefix", Detail: "required config query unavailable"})
				return
			}
			if !json.Valid([]byte(value)) {
				missing = append(missing, key+" (invalid JSON)")
			}
		}
		add(check{Name: "redis.prefix", OK: len(missing) == 0, Detail: "required /go/config/system and currency checked directly", Missing: missing})
	}()
	tasks.Add(1)
	go func() {
		defer tasks.Done()
		if len(cfg.Elastic.Host) == 0 {
			add(check{Name: "es.indices", Detail: "ES not configured"})
			return
		}
		base := strings.TrimRight(cfg.Elastic.Host[0], "/")
		if !strings.Contains(base, "://") {
			base = "http://" + base
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		req, e := http.NewRequestWithContext(ctx, http.MethodGet, base+"/_cat/indices/go_*?format=json&h=index", nil)
		if e != nil {
			add(check{Name: "es.indices", Detail: "invalid ES address"})
			return
		}
		req.SetBasicAuth(cfg.Elastic.UserName, cfg.Elastic.Password)
		client := http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		resp, e := client.Do(req)
		if e != nil {
			add(check{Name: "es.indices", Detail: "connection unavailable"})
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			add(check{Name: "es.indices", Detail: fmt.Sprintf("index metadata returned HTTP %d", resp.StatusCode)})
			return
		}
		var rows []struct {
			Index string `json:"index"`
		}
		if json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rows) != nil {
			add(check{Name: "es.indices", Detail: "invalid index metadata response"})
			return
		}
		exists := map[string]bool{}
		for _, row := range rows {
			exists[row.Index] = true
		}
		missing := []string{}
		for _, index := range []string{esindex.Settlement(), esindex.FlowingWater(), esindex.PoolRecordLog(), esindex.Name("gogame_records"), esindex.Name("gogame_replays")} {
			if !exists[index] {
				missing = append(missing, index)
			}
		}
		add(check{Name: "es.indices", OK: len(missing) == 0, Detail: fmt.Sprintf("read %d go_ indices", len(rows)), Missing: missing})
	}()
	tasks.Wait()
	report := map[string]any{"readOnly": true, "indexPrefix": esindex.Prefix, "targetDatabases": []string{"go_manager", "go_player"}, "checks": results}
	result, _ := json.MarshalIndent(report, "", "  ")
	fmt.Println(string(result))
	if *output != "" {
		if e := os.WriteFile(*output, append(result, '\n'), 0600); e != nil {
			fmt.Println("Report could not be written")
			os.Exit(2)
		}
	}
	for _, r := range results {
		if !r.OK {
			os.Exit(1)
		}
	}
}
