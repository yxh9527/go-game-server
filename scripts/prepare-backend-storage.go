// Prepare only missing go_ indices and absent Redis configuration from the
// authoritative go_manager pool_config table. No fake game or wallet records.
package main

import (
	"app/config"
	"app/esindex"
	"app/tables/manager"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	mysql "github.com/go-sql-driver/mysql"
	"github.com/redis/go-redis/v9"
	"gopkg.in/yaml.v2"
)

type silentRedis struct{}

func (silentRedis) Printf(context.Context, string, ...interface{}) {}

type configValue struct{ key, value string }
type preparation struct {
	Index  string `json:"index"`
	Action string `json:"action"`
}

func indexDefinitions() map[string]map[string]any {
	text := func() map[string]any {
		return map[string]any{"type": "text", "fields": map[string]any{"keyword": map[string]any{"type": "keyword", "ignore_above": 1024}}}
	}
	base := func() map[string]any {
		fields := map[string]any{}
		for _, name := range []string{"agentId", "userId", "gameId", "webId", "level", "playedDate", "createTime"} {
			fields[name] = map[string]any{"type": "long"}
		}
		for _, name := range []string{"currency", "currencySymbol", "symbol", "hash", "account", "roundID", "roundId", "flowingWaterOn"} {
			fields[name] = text()
		}
		return fields
	}
	definition := func(fields map[string]any) map[string]any {
		return map[string]any{"mappings": map[string]any{"dynamic": true, "date_detection": false, "properties": fields}}
	}
	settlement := base()
	for _, name := range []string{"bet", "exBet", "win", "exWin", "balance", "chips", "revenue", "exRevenue", "pmup", "exPmup", "rtp", "base_bet", "balance_cash", "balance_bonus"} {
		settlement[name] = map[string]any{"type": "double"}
	}
	settlement["complete"] = map[string]any{"type": "boolean"}
	bills := base()
	for _, name := range []string{"bet", "award", "currentScore"} {
		bills[name] = map[string]any{"type": "double"}
	}
	pool := map[string]any{"agentId": map[string]any{"type": "long"}, "areaId": map[string]any{"type": "long"}, "createTime": map[string]any{"type": "long"}, "symbol": text()}
	for _, name := range []string{"poolValue", "normal", "normalRate", "min", "minRate", "max", "maxRate", "ctl", "revenue"} {
		pool[name] = map[string]any{"type": "double"}
	}
	history := base()
	history["id"] = text()
	history["gameId"] = text()
	for _, name := range []string{"roomType", "roomId", "inning", "endedAt", "playMode", "effectiveBet", "net", "balance", "takeIn"} {
		history[name] = map[string]any{"type": "long"}
	}
	history["privateRoom"] = map[string]any{"type": "boolean"}
	// Records are queried by root identity fields; arbitrary card/action payloads
	// stay in _source without creating thousands of dynamic player/room fields.
	for _, name := range []string{"room", "detail", "players", "aggregate"} {
		history[name] = map[string]any{"type": "object", "enabled": false}
	}
	return map[string]map[string]any{esindex.Settlement(): definition(settlement), esindex.FlowingWater(): definition(bills), esindex.PoolRecordLog(): definition(pool), esindex.Name("gogame_records"): definition(history), esindex.Name("gogame_replays"): definition(history)}
}

type elasticTarget struct {
	base, user, password string
	client               *http.Client
}

func (e elasticTarget) request(ctx context.Context, method, index string, body any) (int, map[string]any, error) {
	var data io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, errors.New("invalid index definition")
		}
		data = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, e.base+"/"+index, data)
	if err != nil {
		return 0, nil, errors.New("invalid ES endpoint")
	}
	req.SetBasicAuth(e.user, e.password)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := e.client.Do(req)
	if err != nil {
		return 0, nil, errors.New("ES request unavailable")
	}
	defer response.Body.Close()
	var value map[string]any
	_ = json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&value)
	return response.StatusCode, value, nil
}
func validateMapping(index string, response, definition map[string]any) error {
	actual, _ := response[index].(map[string]any)
	mappings, _ := actual["mappings"].(map[string]any)
	properties, _ := mappings["properties"].(map[string]any)
	expected := definition["mappings"].(map[string]any)["properties"].(map[string]any)
	if properties == nil {
		return fmt.Errorf("%s has no compatible mapping", index)
	}
	// Existing indices can have extra fields. Never modify or delete their mapping.
	for _, name := range []string{"agentId", "userId", "roomId", "inning", "endedAt", "id"} {
		desired, required := expected[name].(map[string]any)
		if !required {
			continue
		}
		field, exists := properties[name].(map[string]any)
		if !exists {
			return fmt.Errorf("%s is missing required field %s", index, name)
		}
		if field["type"] != desired["type"] {
			return fmt.Errorf("%s has incompatible field %s", index, name)
		}
		if name == "id" {
			nested, _ := field["fields"].(map[string]any)
			keyword, _ := nested["keyword"].(map[string]any)
			if keyword["type"] != "keyword" {
				return fmt.Errorf("%s requires id.keyword for sorting", index)
			}
		}
	}
	return nil
}
func inspectIndices(ctx context.Context, target elasticTarget, definitions map[string]map[string]any) ([]preparation, error) {
	indices := []string{}
	for index := range definitions {
		indices = append(indices, index)
	}
	sort.Strings(indices)
	plan := []preparation{}
	for _, index := range indices {
		status, value, err := target.request(ctx, http.MethodGet, index+"/_mapping", nil)
		if err != nil {
			return nil, err
		}
		if status == 404 {
			plan = append(plan, preparation{Index: index, Action: "create-empty"})
			continue
		}
		if status != 200 {
			return nil, fmt.Errorf("ES mapping inspection returned HTTP %d", status)
		}
		if err = validateMapping(index, value, definitions[index]); err != nil {
			return nil, err
		}
		plan = append(plan, preparation{Index: index, Action: "keep-existing"})
	}
	return plan, nil
}
func createMissingIndices(ctx context.Context, target elasticTarget, definitions map[string]map[string]any, plan []preparation) error {
	for _, item := range plan {
		if item.Action != "create-empty" {
			continue
		}
		status, value, err := target.request(ctx, http.MethodPut, item.Index, definitions[item.Index])
		if err != nil {
			return err
		}
		if status == 200 && value["acknowledged"] == true {
			continue
		}
		// A concurrent initializer may have created this exact compatible index.
		if status == 400 {
			code, existing, e := target.request(ctx, http.MethodGet, item.Index+"/_mapping", nil)
			if e == nil && code == 200 && validateMapping(item.Index, existing, definitions[item.Index]) == nil {
				continue
			}
		}
		return fmt.Errorf("create empty index %s returned HTTP %d", item.Index, status)
	}
	return nil
}

func loadConfigs(ctx context.Context, db *sql.DB) ([]configValue, error) {
	rows, err := db.QueryContext(ctx, "SELECT `key`,`value` FROM "+(&manager.PoolConfig{}).TableName()+" ORDER BY id LIMIT 10001")
	if err != nil {
		return nil, errors.New("go_manager pool_config query failed")
	}
	defer rows.Close()
	values := []configValue{}
	seen := map[string]string{}
	bytesTotal := 0
	for rows.Next() {
		var item configValue
		if rows.Scan(&item.key, &item.value) != nil {
			return nil, errors.New("invalid pool configuration row")
		}
		if !strings.HasPrefix(item.key, esindex.PathRoot()+"/config/") && !strings.HasPrefix(item.key, esindex.PathRoot()+"/agent/") {
			return nil, errors.New("pool configuration contains a key outside the go namespace")
		}
		if len(item.key) > 512 || strings.ContainsAny(item.key, "\r\n") || len(item.value) > 1<<20 || !json.Valid([]byte(item.value)) {
			return nil, errors.New("pool configuration has an invalid key or JSON value")
		}
		if previous, exists := seen[item.key]; exists {
			if previous != item.value {
				return nil, errors.New("duplicate pool configuration key conflicts")
			}
			continue
		}
		bytesTotal += len(item.value)
		if bytesTotal > 32<<20 || len(values) >= 10000 {
			return nil, errors.New("configuration preparation exceeds its bounded size")
		}
		seen[item.key] = item.value
		values = append(values, item)
	}
	if rows.Err() != nil {
		return nil, errors.New("pool configuration read failed")
	}
	if len(values) == 0 {
		return nil, errors.New("go_manager has no default configuration rows")
	}
	for _, key := range []string{esindex.ConfigKey("system"), esindex.ConfigKey("currency")} {
		if _, ok := seen[key]; !ok {
			return nil, errors.New("required system or currency configuration is missing from MySQL")
		}
	}
	return values, nil
}
func inspectConfigs(ctx context.Context, client redis.UniversalClient, values []configValue) (int, int, error) {
	missing, existing := 0, 0
	for _, item := range values {
		value, err := client.Get(ctx, item.key).Result()
		if err == redis.Nil {
			missing++
			continue
		}
		if err != nil {
			return 0, 0, errors.New("Redis configuration inspection failed")
		}
		if value != item.value {
			return 0, 0, fmt.Errorf("Redis configuration differs from MySQL at %s; existing value was preserved", item.key)
		}
		existing++
	}
	return missing, existing, nil
}

const fillConfigScript = `local old=redis.call('GET',KEYS[1]); if old==false then redis.call('SET',KEYS[1],ARGV[1]); return 1 end; if old==ARGV[1] then return 0 end; return -1`

func fillConfigs(ctx context.Context, client redis.UniversalClient, values []configValue) (int, error) {
	written := 0
	for _, item := range values {
		code, err := client.Eval(ctx, fillConfigScript, []string{item.key}, item.value).Int()
		if err != nil {
			return written, errors.New("Redis configuration synchronization interrupted; safe to retry")
		}
		if code < 0 {
			return written, fmt.Errorf("concurrent Redis configuration change at %s; existing value was preserved", item.key)
		}
		written += code
	}
	return written, nil
}

func run(configFile string, apply bool, report map[string]any) error {
	if esindex.Prefix != "go" {
		return errors.New("storage preparation requires the confirmed go namespace")
	}
	raw, err := os.ReadFile(configFile)
	if err != nil {
		return errors.New("configuration could not be read")
	}
	var cfg config.RunConfig
	if yaml.Unmarshal(raw, &cfg) != nil {
		return errors.New("invalid YAML configuration")
	}
	if cfg.Mysql["manager"].Database != "go_manager" || cfg.Mysql["player"].Database != "go_player" {
		return errors.New("service databases must be go_manager/go_player before storage preparation")
	}
	source := cfg.Mysql["manager"]
	options := mysql.NewConfig()
	options.User = source.User
	options.Passwd = source.Password
	options.Net = "tcp"
	options.Addr = net.JoinHostPort(source.Host, fmt.Sprint(source.Port))
	options.DBName = source.Database
	options.Timeout = 3 * time.Second
	options.ReadTimeout = 5 * time.Second
	options.WriteTimeout = 5 * time.Second
	db, err := sql.Open("mysql", options.FormatDSN())
	if err != nil {
		return errors.New("MySQL connection setup failed")
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if db.PingContext(ctx) != nil {
		return errors.New("MySQL connection or authentication unavailable")
	}
	values, err := loadConfigs(ctx, db)
	if err != nil {
		return err
	}
	client := redis.NewUniversalClient(&redis.UniversalOptions{Addrs: cfg.Redis.Host, Username: cfg.Redis.User, Password: cfg.Redis.Pwd, DialTimeout: 3 * time.Second, ReadTimeout: 3 * time.Second, WriteTimeout: 3 * time.Second, MaxRetries: -1})
	defer client.Close()
	missing, existing, err := inspectConfigs(ctx, client, values)
	if err != nil {
		return err
	}
	report["mysqlConfigRows"] = len(values)
	report["redisMissing"] = missing
	report["redisMatching"] = existing
	if len(cfg.Elastic.Host) == 0 {
		return errors.New("ES connection is not configured")
	}
	base := strings.TrimRight(cfg.Elastic.Host[0], "/")
	if !strings.Contains(base, "://") {
		base = "http://" + base
	}
	target := elasticTarget{base: base, user: cfg.Elastic.UserName, password: cfg.Elastic.Password, client: &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
	definitions := indexDefinitions()
	plan, err := inspectIndices(ctx, target, definitions)
	if err != nil {
		return err
	}
	report["indices"] = plan
	if !apply {
		return nil
	}
	if err = createMissingIndices(ctx, target, definitions, plan); err != nil {
		return err
	}
	written, err := fillConfigs(ctx, client, values)
	report["redisWritten"] = written
	if err != nil {
		return err
	}
	if _, _, err = inspectConfigs(ctx, client, values); err != nil {
		return err
	}
	verified, err := inspectIndices(ctx, target, definitions)
	if err != nil {
		return err
	}
	for _, item := range verified {
		if item.Action != "keep-existing" {
			return errors.New("new ES index was not confirmed after preparation")
		}
	}
	report["verified"] = true
	return nil
}
func main() {
	_ = mysql.SetLogger(log.New(io.Discard, "", 0))
	redis.SetLogger(silentRedis{})
	configFile := flag.String("config", "", "existing lottery YAML connection source")
	apply := flag.Bool("apply", false, "create only missing empty indices and fill absent go configuration keys")
	output := flag.String("report", "", "sanitized report path")
	flag.Parse()
	report := map[string]any{"apply": *apply, "indexPrefix": esindex.Prefix, "gameDocumentsWritten": 0, "sqlWrites": false, "existingConfigOverwrite": false}
	err := run(*configFile, *apply, report)
	if err != nil {
		report["error"] = err.Error()
	}
	raw, _ := json.MarshalIndent(report, "", "  ")
	fmt.Println(string(raw))
	if *output != "" {
		if os.WriteFile(*output, append(raw, '\n'), 0600) != nil {
			fmt.Println("Sanitized report could not be saved")
			os.Exit(2)
		}
	}
	if err != nil {
		os.Exit(1)
	}
}
