package main

import (
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The build copies the standalone HTML here, so the .exe can run on its own.
//
//go:embed ui.html
var page string

type localApp struct {
	authority string
	prefix    string
	document  string
	catalog   catalog
	lifetime  windowLifetime
	saveMu    sync.Mutex
	saved     map[string]savedFile
}

func newApp(authority string, locations func() []scanRoot) *localApp {
	var secret [24]byte
	rand.Read(secret[:])
	html := strings.Replace(page, `name="koharu-edition" content="standalone"`, `name="koharu-edition" content="windows"`, 1)
	html = strings.Replace(html, "connect-src 'none'", "connect-src 'self'", 1)
	app := &localApp{authority: authority, prefix: "/" + hex.EncodeToString(secret[:]) + "/", document: html, catalog: catalog{locations: locations}, saved: make(map[string]savedFile)}
	app.lifetime.idleSince = time.Now()
	return app
}

// Each open tab holds one HTTP request. Count file reads and saves as well,
// so a write already in progress can finish or clean up before the process exits.
type windowLifetime struct {
	mu        sync.Mutex
	active    int
	opened    bool
	stopping  bool
	idleSince time.Time
}

func (life *windowLifetime) enter(page bool) bool {
	life.mu.Lock()
	defer life.mu.Unlock()
	if life.stopping {
		return false
	}
	life.active++
	life.opened = life.opened || page
	return true
}

func (life *windowLifetime) leave() {
	life.mu.Lock()
	defer life.mu.Unlock()
	life.active--
	if life.active == 0 {
		life.idleSince = time.Now()
	}
}

func (life *windowLifetime) expire(now time.Time, startup, grace time.Duration) bool {
	life.mu.Lock()
	defer life.mu.Unlock()
	wait := startup
	if life.opened {
		wait = grace
	}
	if life.active == 0 && now.Sub(life.idleSince) >= wait {
		life.stopping = true
	}
	return life.stopping
}

func windowEvents(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	control := http.NewResponseController(w)
	if _, err := io.WriteString(w, "retry: 500\n: connected\n\n"); err != nil || control.Flush() != nil {
		return
	}
	// An abrupt browser exit also releases the request's context. The small
	// heartbeat detects a connection dropped without a normal TCP close.
	pulse := time.NewTicker(15 * time.Second)
	defer pulse.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-pulse.C:
			if _, err := io.WriteString(w, ": open\n\n"); err != nil || control.Flush() != nil {
				return
			}
		}
	}
}

func (app *localApp) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h := w.Header()
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Content-Security-Policy", "frame-ancestors 'none'; object-src 'none'")
	origin := r.Header.Get("Origin")
	if r.Host != app.authority || (origin != "" && origin != "http://"+app.authority) ||
		r.Header.Get("Sec-Fetch-Site") == "cross-site" || r.URL.RawQuery != "" || r.URL.EscapedPath() != r.URL.Path ||
		!strings.HasPrefix(r.URL.Path, app.prefix) {
		http.NotFound(w, r)
		return
	}
	leaf := strings.TrimPrefix(r.URL.Path, app.prefix)
	if !app.lifetime.enter(r.Method == http.MethodGet && (leaf == "" || leaf == "window")) {
		http.Error(w, "The migrator is closing.", http.StatusServiceUnavailable)
		return
	}
	defer app.lifetime.leave()
	if r.Method == http.MethodPost && strings.HasPrefix(leaf, "save/") {
		if origin != "http://"+app.authority || r.Header.Get("X-Koharu-Save") != "1" || r.Header.Get("Content-Type") != "application/octet-stream" {
			http.Error(w, "This save request did not come from the migrator.", http.StatusForbidden)
			return
		}
		app.saveProject(w, r, strings.TrimPrefix(leaf, "save/"))
		return
	}
	if r.Method != http.MethodGet {
		http.NotFound(w, r)
		return
	}
	switch leaf {
	case "":
		h.Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, app.document)
	case "window":
		windowEvents(w, r)
	case "scan":
		result, err := app.catalog.scan(r.Context())
		if err != nil {
			http.Error(w, "The project locations are unavailable.", http.StatusServiceUnavailable)
			return
		}
		h.Set("Content-Type", "application/json; charset=utf-8")
		json.NewEncoder(w).Encode(result)
	default:
		parts := strings.Split(leaf, "/")
		if parts[0] != "project" {
			http.NotFound(w, r)
			return
		}
		file, size, err := app.catalog.open(parts)
		if err != nil {
			http.Error(w, "Project file unavailable.", fileError(err))
			return
		}
		defer file.Close()
		h.Set("Content-Type", "application/octet-stream")
		h.Set("Content-Length", strconv.FormatInt(size, 10))
		io.Copy(w, file)
	}
}

func run() error {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("could not start the local scanner: %w", err)
	}
	defer listener.Close()
	app := newApp(listener.Addr().String(), projectLocations)
	server := &http.Server{Handler: app, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	defer server.Close()
	serving := make(chan error, 1)
	go func() { serving <- server.Serve(listener) }()
	if err := openBrowser("http://" + app.authority + app.prefix); err != nil {
		return err
	}
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case err := <-serving:
			return err
		case now := <-ticker.C:
			if app.lifetime.expire(now, 90*time.Second, 4*time.Second) {
				// All app requests have finished. Close speculative browser
				// connections too, even if they never sent a request.
				return nil
			}
		}
	}
}

func main() {
	if err := run(); err != nil {
		showError("The scanner could not start. Open the Extras folder, then open Koharu-Project-Migrator.html and choose Scan Documents.\n\n" + err.Error())
	}
}
