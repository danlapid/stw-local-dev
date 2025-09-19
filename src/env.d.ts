interface Env {
	OTEL_ENDPOINT?: string;

	// KV Namespaces
	CACHE_KV: KVNamespace;
	USER_DATA: KVNamespace;

	// D1 Database
	DB: D1Database;

	// R2 Storage
	ASSETS: R2Bucket;
	UPLOADS: R2Bucket;

	// Queues
	ANALYTICS_QUEUE: Queue;

	// Service Bindings
	AUTH_SERVICE?: Fetcher;

	// Environment variables
	API_SECRET?: string;
	ENVIRONMENT?: string;
}