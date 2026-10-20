package httpapi

import (
	"net/http"
	"strings"
)

// CORS allows only configured browser origins and only the API's methods and
// headers. Authentication still runs on every non-preflight request.
//
// The private single-owner sync API keeps this narrower header set.
func CORS(origins []string, next http.Handler) http.Handler {
	return corsHandler(origins, "GET, POST, DELETE, OPTIONS", "Authorization, Content-Type", next)
}

// CORSWithHeaders behaves like CORS and additionally allows the listed request
// headers. The online participant API uses it for the guest seat credential
// header and for the stream cursor header, so the private sync API is never
// widened to accept them.
func CORSWithHeaders(origins []string, extraHeaders []string, next http.Handler) http.Handler {
	return CORSWithMethods(origins, extraHeaders, "GET, POST, OPTIONS", next)
}

// CORSWithMethods behaves like CORSWithHeaders and additionally allows the
// listed methods.
//
// The public profile API edits a profile, so it needs PUT in its preflight
// answer. The private single-owner sync API keeps its narrower method set.
func CORSWithMethods(origins []string, extraHeaders []string, methods string, next http.Handler) http.Handler {
	headers := "Authorization, Content-Type"
	if len(extraHeaders) > 0 {
		headers += ", " + strings.Join(extraHeaders, ", ")
	}
	return corsHandler(origins, methods, headers, next)
}

func corsHandler(origins []string, methods, headers string, next http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(origins))
	for _, origin := range origins {
		if origin != "" {
			allowed[origin] = struct{}{}
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(r.Header.Values("Origin")) > 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		origin := r.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(w, r)
			return
		}
		if _, ok := allowed[origin]; !ok {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", methods)
			w.Header().Set("Access-Control-Allow-Headers", headers)
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
