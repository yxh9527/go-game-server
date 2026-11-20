package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

type configDriver struct{ values [][]driver.Value }
type configConn struct{ values [][]driver.Value }
type configRows struct{ values [][]driver.Value }

var configDriverSequence atomic.Int64

func (d configDriver) Open(string) (driver.Conn, error) { return &configConn{d.values}, nil }
func (c *configConn) Close() error                      { return nil }
func (c *configConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepare")
}
func (c *configConn) Begin() (driver.Tx, error) {
	return nil, errors.New("configuration read must not start a write transaction")
}
func (c *configConn) QueryContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
	if !strings.Contains(query, "FROM pool_config ORDER BY id LIMIT 10001") {
		return nil, errors.New("wrong authoritative configuration table")
	}
	return &configRows{values: append([][]driver.Value(nil), c.values...)}, nil
}
func (r *configRows) Columns() []string { return []string{"key", "value"} }
func (r *configRows) Close() error      { return nil }
func (r *configRows) Next(values []driver.Value) error {
	if len(r.values) == 0 {
		return io.EOF
	}
	copy(values, r.values[0])
	r.values = r.values[1:]
	return nil
}

func TestConfigurationSourceUsesModelTableAndRejectsInvalidOrIncompleteSeedRows(t *testing.T) {
	for _, kind := range []string{"valid", "old-prefix", "invalid-json", "duplicate-conflict", "missing-system"} {
		t.Run(kind, func(t *testing.T) {
			values := [][]driver.Value{{"/go/config/system", `{"game_url":[]}`}, {"/go/config/currency", `{"currency":{"CNY":1}}`}}
			switch kind {
			case "old-prefix":
				values[0][0] = "/fg/config/system"
			case "invalid-json":
				values[0][1] = "invalid"
			case "duplicate-conflict":
				values = append(values, []driver.Value{"/go/config/system", `{"different":true}`})
			case "missing-system":
				values = values[1:]
			}
			name := fmt.Sprintf("config-source-%d", configDriverSequence.Add(1))
			sql.Register(name, configDriver{values})
			db, err := sql.Open(name, "")
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			result, err := loadConfigs(context.Background(), db)
			if kind == "valid" {
				if err != nil || len(result) != 2 {
					t.Fatal(result, err)
				}
			} else if err == nil {
				t.Fatal("invalid seed configuration accepted")
			}
		})
	}
}

func TestConfigurationFillIsRetryableAndNeverOverwritesConcurrentChanges(t *testing.T) {
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	defer client.Close()
	ctx := context.Background()
	values := []configValue{{"/go/config/system", `{"game_url":[]}`}, {"/go/config/currency", `{"currency":{"CNY":1}}`}}
	missing, matching, err := inspectConfigs(ctx, client, values)
	if err != nil || missing != 2 || matching != 0 {
		t.Fatal(missing, matching, err)
	}
	written, err := fillConfigs(ctx, client, values)
	if err != nil || written != 2 {
		t.Fatal(written, err)
	}
	written, err = fillConfigs(ctx, client, values)
	if err != nil || written != 0 {
		t.Fatal("retry rewrote values", written, err)
	}
	client.Set(ctx, values[1].key, `{"currency":{"CNY":2}}`, time.Hour)
	_, _, err = inspectConfigs(ctx, client, values)
	if err == nil {
		t.Fatal("existing conflicting configuration was accepted")
	}
	_, err = fillConfigs(ctx, client, values)
	if err == nil {
		t.Fatal("concurrent value overwritten")
	}
	if client.Get(ctx, values[1].key).Val() != `{"currency":{"CNY":2}}` || client.TTL(ctx, values[1].key).Val() <= 0 {
		t.Fatal("changed existing value or its TTL")
	}
}

func TestEmptyIndexPreparationUsesExpectedMappingsAndPreservesExistingIndices(t *testing.T) {
	definitions := indexDefinitions()
	stored := map[string]map[string]any{}
	writes := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		index := strings.Split(strings.Trim(r.URL.Path, "/"), "/")[0]
		w.Header().Set("Content-Type", "application/json")
		if !strings.HasPrefix(index, "go_") {
			t.Error("unexpected index", index)
			w.WriteHeader(400)
			return
		}
		switch r.Method {
		case http.MethodGet:
			if body, ok := stored[index]; ok {
				_ = json.NewEncoder(w).Encode(map[string]any{index: body})
			} else {
				w.WriteHeader(404)
				_, _ = w.Write([]byte(`{"error":"missing"}`))
			}
		case http.MethodPut:
			var body map[string]any
			if json.NewDecoder(r.Body).Decode(&body) != nil {
				t.Error("invalid mapping")
			}
			stored[index] = body
			writes++
			_, _ = w.Write([]byte(`{"acknowledged":true}`))
		default:
			t.Error("unexpected data mutation", r.Method)
			w.WriteHeader(400)
		}
	}))
	defer server.Close()
	target := elasticTarget{base: server.URL, client: server.Client()}
	ctx := context.Background()
	plan, err := inspectIndices(ctx, target, definitions)
	if err != nil || len(plan) != 5 {
		t.Fatal(plan, err)
	}
	if writes != 0 {
		t.Fatal("preview created indices")
	}
	if err = createMissingIndices(ctx, target, definitions, plan); err != nil {
		t.Fatal(err)
	}
	if writes != 5 {
		t.Fatal("wrong empty index count", writes)
	}
	plan, err = inspectIndices(ctx, target, definitions)
	if err != nil {
		t.Fatal(err)
	}
	if err = createMissingIndices(ctx, target, definitions, plan); err != nil {
		t.Fatal(err)
	}
	if writes != 5 {
		t.Fatal("existing indices recreated")
	}
	for index, body := range stored {
		properties := body["mappings"].(map[string]any)["properties"].(map[string]any)
		if strings.Contains(index, "gogame_") {
			for _, field := range []string{"detail", "players", "room"} {
				if properties[field].(map[string]any)["enabled"] != false {
					t.Fatal("dynamic nested payload not bounded", field)
				}
			}
			delete(properties, "id")
			if validateMapping(index, map[string]any{index: body}, definitions[index]) == nil {
				t.Fatal("index without sortable identity accepted")
			}
		}
	}
}
