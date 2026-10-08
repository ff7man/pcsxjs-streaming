// pcsxjs test server: serves the emulator and ranged game files from one port.
// The default games path follows the existing eNGE symlink so this can test the
// same Digimon World files without copying a large BIN into this repository.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

type testServer struct {
	docsDir  string
	gamesDir string
	cloudDir string
}

type gameEntry struct {
	name string
	url  string
}

const memoryCardSize = 128 * 1024
const maxStateBytes = 32 * 1024 * 1024

// ensureGamesCSV creates the same small catalog used by eNGE.  CUE files are
// the disc entry points because they preserve multi-track/audio layout; the
// browser can then request the referenced BIN files from the same server.
func ensureGamesCSV(gamesDir string) error {
	root, err := filepath.EvalSymlinks(gamesDir)
	if err != nil {
		return err
	}
	csvPath := filepath.Join(root, "games.csv")
	if _, err := os.Stat(csvPath); err == nil {
		log.Printf("using existing games catalog: %s", csvPath)
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}

	var games []gameEntry
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".cue") {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		parts := strings.Split(filepath.ToSlash(relative), "/")
		encodedParts := make([]string, len(parts))
		for i, part := range parts {
			encodedParts[i] = url.PathEscape(part)
		}
		name := strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name()))
		if len(parts) > 1 {
			name = parts[0]
		}
		games = append(games, gameEntry{name: name, url: "/" + strings.Join(encodedParts, "/")})
		return nil
	})
	if err != nil {
		return err
	}
	sort.Slice(games, func(i, j int) bool { return strings.ToLower(games[i].name) < strings.ToLower(games[j].name) })

	file, err := os.Create(csvPath)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, err := fmt.Fprintln(file, "name,url"); err != nil {
		return err
	}
	for _, game := range games {
		if _, err := fmt.Fprintf(file, "%s,%s\n", csvField(game.name), csvField(game.url)); err != nil {
			return err
		}
	}
	log.Printf("created games catalog: %s with %d CUE game(s)", csvPath, len(games))
	return nil
}

func csvField(value string) string {
	if !strings.ContainsAny(value, ",\"\r\n") {
		return value
	}
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func localIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err == nil {
		defer conn.Close()
		if address, ok := conn.LocalAddr().(*net.UDPAddr); ok {
			return address.IP.String()
		}
	}
	return "127.0.0.1"
}

func safePath(root, requestPath string) (string, bool) {
	clean := filepath.Clean(filepath.FromSlash(strings.TrimPrefix(requestPath, "/")))
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		return "", false
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return "", false
	}
	path := filepath.Join(root, clean)
	resolved, err := filepath.Abs(path)
	if err != nil || (resolved != root && !strings.HasPrefix(resolved, root+string(os.PathSeparator))) {
		return "", false
	}
	return resolved, true
}

func contentType(path string) string {
	if value := mime.TypeByExtension(filepath.Ext(path)); value != "" {
		return value
	}
	return "application/octet-stream"
}

func (s *testServer) cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, PUT, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Range, Content-Type")
	w.Header().Set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length")
	w.Header().Set("Cache-Control", "no-store, max-age=0")
}

func (s *testServer) fileForPath(requestPath string) (string, os.FileInfo, error) {
	if requestPath == "/" {
		requestPath = "/pcsx_ww.html"
	}
	for _, root := range []string{s.docsDir, s.gamesDir} {
		path, ok := safePath(root, requestPath)
		if !ok {
			continue
		}
		info, err := os.Stat(path)
		if err == nil && !info.IsDir() {
			return path, info, nil
		}
	}
	return "", nil, os.ErrNotExist
}

func (s *testServer) staticFile(w http.ResponseWriter, r *http.Request) {
	path, info, err := s.fileForPath(r.URL.Path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(path)
	if err != nil {
		http.Error(w, "unable to open file", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	size := info.Size()
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Type", contentType(path))
	rangeHeader := r.Header.Get("Range")
	if rangeHeader == "" {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		http.ServeContent(w, r, info.Name(), info.ModTime(), f)
		return
	}

	// This test server intentionally accepts one byte range, which is what the
	// streaming CD backend sends. Invalid or unsatisfiable ranges return 416.
	if !strings.HasPrefix(rangeHeader, "bytes=") || strings.Contains(rangeHeader, ",") {
		http.Error(w, "invalid range", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	parts := strings.SplitN(strings.TrimPrefix(rangeHeader, "bytes="), "-", 2)
	if len(parts) != 2 {
		http.Error(w, "invalid range", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= size {
		http.Error(w, "range start is outside the file", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	end := size - 1
	if parts[1] != "" {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || end < start {
			http.Error(w, "invalid range", http.StatusRequestedRangeNotSatisfiable)
			return
		}
		if end >= size {
			end = size - 1
		}
	}

	length := end - start + 1
	w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, size))
	w.Header().Set("Content-Length", strconv.FormatInt(length, 10))
	w.WriteHeader(http.StatusPartialContent)
	if r.Method == http.MethodHead {
		return
	}
	if _, err := f.Seek(start, io.SeekStart); err != nil {
		return
	}
	_, _ = io.CopyN(w, f, length)
}

func (s *testServer) cloud(w http.ResponseWriter, r *http.Request) {
	name := ""
	contentType := "application/octet-stream"
	limit := int64(memoryCardSize)
	switch r.URL.Path {
	case "/api/status":
		state, _ := os.Stat(filepath.Join(s.cloudDir, "state.gz"))
		card, _ := os.Stat(filepath.Join(s.cloudDir, "memorycard.mcr"))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"state": state != nil, "memorycard": card != nil})
		return
	case "/api/state":
		name, contentType, limit = "state.gz", "application/gzip", maxStateBytes
	case "/api/memorycard":
		name = "memorycard.mcr"
	default:
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(s.cloudDir, name)
	if r.Method == http.MethodGet {
		data, err := os.ReadFile(path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
		return
	}
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil || int64(len(data)) > limit {
		http.Error(w, "uploaded file is too large", http.StatusRequestEntityTooLarge)
		return
	}
	if err := os.MkdirAll(s.cloudDir, 0755); err != nil {
		http.Error(w, "unable to create cloud directory", 500)
		return
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		http.Error(w, "unable to save cloud file", 500)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *testServer) handler(w http.ResponseWriter, r *http.Request) {
	s.cors(w)
	if strings.HasPrefix(r.URL.Path, "/api/") {
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
			return
		}
		s.cloud(w, r)
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	s.staticFile(w, r)
}

func main() {
	host := flag.String("host", "0.0.0.0", "address to bind")
	port := flag.Int("port", 8000, "HTTP port")
	docsDir := flag.String("docs", ".", "directory containing pcsxjs HTML/WASM files")
	gamesDir := flag.String("games", "../enge-js/games", "directory or symlink containing game files")
	cloudDir := flag.String("cloud", "cloud-data", "directory for cloud state and memory card files")
	flag.Parse()

	server := &testServer{docsDir: *docsDir, gamesDir: *gamesDir, cloudDir: *cloudDir}
	if err := ensureGamesCSV(*gamesDir); err != nil {
		log.Printf("could not generate games.csv: %v", err)
	}
	handler := http.HandlerFunc(server.handler)
	address := fmt.Sprintf("%s:%d", *host, *port)
	log.Printf("pcsxjs test server listening on http://%s:%d", localIP(), *port)
	log.Printf("docs=%s games=%s (resolved=%s)", *docsDir, *gamesDir, resolvedDir(*gamesDir))
	log.Printf("cloud=%s", *cloudDir)
	log.Printf("raw BIN range test: /Digimon%%20World%%20(USA)/Digimon%%20World%%20(USA).bin")
	log.Fatal(http.ListenAndServe(address, loggingHandler(handler)))
}

func resolvedDir(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "unavailable: " + err.Error()
	}
	return resolved
}

func loggingHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		log.Printf("%s %s %s Range=%q", r.RemoteAddr, r.Method, r.URL.RequestURI(), r.Header.Get("Range"))
		next.ServeHTTP(w, r)
	})
}
