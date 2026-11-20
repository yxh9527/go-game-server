// Operator command: create only the two explicitly named empty go_ databases,
// then use the backend's existing InitMysqlDb entry point. No service startup.
package main

import (
	"app/config"
	"app/tables"
	"app/tables/gogame"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"sync/atomic"
	"time"

	driver "github.com/go-sql-driver/mysql"
	"gopkg.in/yaml.v2"
	"gorm.io/driver/mysql"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type quietLog struct{ failures *atomic.Int64 }

func (q quietLog) LogMode(logger.LogLevel) logger.Interface { return q }
func (q quietLog) Info(context.Context, string, ...any)     {}
func (q quietLog) Warn(context.Context, string, ...any)     {}
func (q quietLog) Error(context.Context, string, ...any)    { q.failures.Add(1) }
func (q quietLog) Trace(_ context.Context, _ time.Time, _ func() (string, int64), err error) {
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		q.failures.Add(1)
	}
}

type target struct {
	role, name string
	db         *sql.DB
}

func main() {
	_ = driver.SetLogger(log.New(io.Discard, "", 0))
	configFile := flag.String("config", "", "backend YAML connection source")
	apply := flag.Bool("apply", false, "create empty go_manager/go_player and invoke InitMysqlDb")
	reportFile := flag.String("report", "", "sanitized report path")
	flag.Parse()
	report := map[string]any{"applied": false, "databases": []string{"go_manager", "go_player"}, "initializer": "app/tables.InitMysqlDb"}
	code := 0
	defer func() {
		if recover() != nil {
			report["error"] = "initialization stopped after a backend schema/seed error; partial new schema may exist"
			code = 1
		}
		raw, _ := json.MarshalIndent(report, "", "  ")
		fmt.Println(string(raw))
		if *reportFile != "" {
			_ = os.WriteFile(*reportFile, append(raw, '\n'), 0600)
		}
		if code != 0 {
			os.Exit(code)
		}
	}()
	fail := func(message string) { report["error"] = message; code = 1 }
	raw, err := os.ReadFile(*configFile)
	if err != nil {
		fail("configuration could not be read")
		return
	}
	var cfg config.RunConfig
	if yaml.Unmarshal(raw, &cfg) != nil {
		fail("configuration is invalid")
		return
	}
	targets := []target{}
	for _, role := range []string{"manager", "player"} {
		source, exists := cfg.Mysql[role]
		if !exists {
			fail("missing mysql role " + role)
			return
		}
		options := driver.NewConfig()
		options.Net = "tcp"
		options.Addr = net.JoinHostPort(source.Host, fmt.Sprint(source.Port))
		options.User = source.User
		options.Passwd = source.Password
		options.Timeout = 3 * time.Second
		options.ReadTimeout = 10 * time.Second
		options.WriteTimeout = 10 * time.Second
		options.Params = map[string]string{"charset": "utf8mb4"}
		options.ParseTime = true
		connection, e := sql.Open("mysql", options.FormatDSN())
		if e != nil {
			fail("MySQL connection setup failed")
			return
		}
		defer connection.Close()
		name := "go_" + role
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		var visible, tablesCount int
		e = connection.PingContext(ctx)
		if e == nil {
			e = connection.QueryRowContext(ctx, "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name=?", name).Scan(&visible)
		}
		if e == nil {
			e = connection.QueryRowContext(ctx, "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=?", name).Scan(&tablesCount)
		}
		cancel()
		if e != nil {
			fail("MySQL connectivity or metadata failed for " + role)
			return
		}
		if tablesCount != 0 {
			fail(name + " already contains tables; refusing to initialize a nonempty database")
			return
		}
		targets = append(targets, target{role: role, name: name, db: connection})
	}
	report["emptyTargetsVerified"] = true
	if !*apply {
		report["next"] = "add --apply to create empty targets and call the existing initializer"
		return
	}
	for _, destination := range targets {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		// Identifiers are fixed constants go_manager/go_player, never request input.
		_, e := destination.db.ExecContext(ctx, "CREATE DATABASE IF NOT EXISTS `"+destination.name+"` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci")
		cancel()
		if e != nil {
			fail("CREATE DATABASE failed for " + destination.name + "; no existing database was deleted")
			return
		}
	}
	var count atomic.Int64
	handles := map[string]*gorm.DB{}
	for _, destination := range targets {
		source := cfg.Mysql[destination.role]
		options := driver.NewConfig()
		options.Net = "tcp"
		options.Addr = net.JoinHostPort(source.Host, fmt.Sprint(source.Port))
		options.User = source.User
		options.Passwd = source.Password
		options.DBName = destination.name
		options.Params = map[string]string{"charset": "utf8mb4"}
		options.ParseTime = true
		options.Timeout = 3 * time.Second
		options.ReadTimeout = 30 * time.Second
		options.WriteTimeout = 30 * time.Second
		db, e := gorm.Open(mysql.New(mysql.Config{DSN: options.FormatDSN()}), &gorm.Config{Logger: quietLog{&count}, DisableAutomaticPing: false})
		if e != nil {
			fail("target database could not be opened: " + destination.name)
			return
		}
		connection, _ := db.DB()
		defer connection.Close()
		handles[destination.role] = db
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	tables.InitMysqlDb(handles["manager"].WithContext(ctx), handles["player"].WithContext(ctx))
	report["applied"] = true
	report["sqlErrors"] = count.Load()
	missing := []string{}
	for _, role := range []string{"manager", "player"} {
		models := gogame.ManagerModels()
		if role == "player" {
			models = append(gogame.PlayerModels(), &gogame.ScratchTicketStorage{})
		}
		for _, model := range models {
			if !handles[role].Migrator().HasTable(model) {
				missing = append(missing, fmt.Sprintf("%s:%T", role, model))
			}
		}
	}
	report["missingTables"] = missing
	if count.Load() != 0 || len(missing) > 0 {
		fail("initializer reported SQL errors or missing tables; new target schema requires review")
		return
	}
	report["verified"] = true
	report["accountsCopied"] = false
	report["existingDatabasesModified"] = false
}
