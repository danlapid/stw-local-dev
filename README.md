# Cloudflare Workers - Streaming Tail with OTEL Visualization

This project demonstrates how to use Cloudflare Workers' Streaming Tail API to export worker execution traces to OpenTelemetry (OTEL) and visualize them using Jaeger.

## Features

- **Real-time trace streaming** from Cloudflare Workers
- **Complete OTEL conversion** of Cloudflare trace events
- **Jaeger visualization** with comprehensive span relationships
- **Type-safe implementation** using Cloudflare's official types
- **Local development friendly** setup with Docker

## Architecture

The solution consists of:

1. **tailStream handler** - Converts Cloudflare trace events to OTEL format
2. **Jaeger** - OTEL-compatible trace visualizer
3. **Docker setup** - Simple local development environment

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start Jaeger (Trace Visualizer)

```bash
docker compose up -d
```

This starts Jaeger with:

- **UI**: <http://localhost:16686>
- **OTLP HTTP**: <http://localhost:4318>

### 3. Run Worker

```bash
npx wrangler dev
```

### 4. View Traces

1. Make requests to your worker: <http://localhost:8787>
2. View traces in Jaeger UI: <http://localhost:16686>
3. Select "cloudflare-worker" service to see traces

## Implementation Details

### Supported Trace Events

The `tailStream` handler processes all Cloudflare trace events:

- **`onset`** - Worker invocation start with context
- **`spanOpen`** - New span creation
- **`spanClose`** - Span completion with outcome
- **`attributes`** - Dynamic span attribute addition
- **`log`** - Console log capture
- **`exception`** - Error and exception tracking
- **`return`** - Response information
- **`outcome`** - Final execution metrics
- **`diagnosticChannel`** - Diagnostic events

### Trace Conversion

Each Cloudflare event is mapped to OTEL spans with:

- **Proper span relationships** (parent-child)
- **Rich metadata** (HTTP details, performance metrics)
- **Structured logging** (console logs as span events)
- **Error tracking** (exceptions with stack traces)

### Event-Specific Enrichment

- **Fetch events**: HTTP method, URL, status codes, CF properties
- **Scheduled events**: Cron expressions, execution times
- **Queue events**: Queue names, batch sizes
- **Performance**: CPU time, wall time metrics
- **Script metadata**: Version, tags, execution model

## Configuration Options

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `OTEL_ENDPOINT` | OTEL traces endpoint URL | `http://localhost:4318/v1/traces` | No |

### Alternative OTEL Exporters

#### Zipkin

```bash
# Replace Jaeger with Zipkin
docker run -d -p 9411:9411 --name zipkin openzipkin/zipkin

# Update environment
OTEL_ENDPOINT=http://localhost:9411/api/v2/spans
```

#### OTEL Collector

```yaml
# docker-compose.yml with OTEL Collector
version: '3.9'
services:
  otel-collector:
    image: otel/opentelemetry-collector:latest
    command: ["--config=/etc/otel-collector-config.yml"]
    volumes:
      - ./otel-collector-config.yml:/etc/otel-collector-config.yml
    ports:
      - "4317:4317"   # OTLP gRPC receiver
      - "4318:4318"   # OTLP HTTP receiver

  jaeger:
    image: jaegertracing/all-in-one:latest
    ports:
      - "16686:16686"
```

### Custom Service Identification

Modify the converter to use dynamic service names:

```typescript
// In extractTags method
tags['service.name'] = onset.scriptName || 'cloudflare-worker';
tags['service.version'] = onset.scriptVersion?.id || 'unknown';
tags['service.namespace'] = onset.dispatchNamespace || 'default';
```

## Troubleshooting

### No Traces Appearing

1. **Check Jaeger is running**: Visit <http://localhost:16686>
2. **Verify OTEL endpoint**: Ensure `OTEL_ENDPOINT` is set correctly
3. **Check worker logs**: Look for export errors in wrangler dev output
4. **Network connectivity**: Ensure worker can reach Jaeger (check Docker networking)

### Incomplete Traces

- **Missing spans**: Check for unmatched SpanOpen/SpanClose events
- **Broken relationships**: Verify span context propagation in complex workflows
- **Missing attributes**: Ensure attributes events are being processed

### Performance Issues

- **High trace volume**: Consider sampling or filtering in production
- **Memory usage**: Large trace batches may cause memory pressure
- **Export failures**: Check Jaeger capacity and network reliability

### Docker Issues

```bash
# Reset Docker environment
docker compose down -v
docker compose up -d

# Check container logs
docker compose logs jaeger

# Verify port availability
netstat -an | grep 16686
```

### Development Tips

1. **Add debug logging**: Enable verbose logging in the converter
2. **Test with curl**: Make direct OTEL API calls to verify format
3. **Use Jaeger CLI**: Query traces programmatically
4. **Monitor resources**: Watch memory/CPU usage during development

## Advanced Usage

### Production Deployment

For production use:

1. **Use external OTEL collector** instead of direct Jaeger
2. **Implement trace sampling** to manage volume
3. **Add authentication** to OTEL endpoints
4. **Configure retention policies** in your trace storage
5. **Set up alerting** on trace export failures

### Custom Event Processing

Extend the converter for custom trace enrichment:

```typescript
// Add custom span tags
private extractTags(onset: TailStream.Onset): Record<string, any> {
  const tags = super.extractTags(onset);

  // Add custom business logic tags
  if (onset.info.type === 'fetch') {
    tags['user.region'] = onset.info.cfJson?.colo;
    tags['request.id'] = generateRequestId();
  }

  return tags;
}
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Submit a pull request

## License

MIT License - see LICENSE file for details.