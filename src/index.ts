import { SpanStatusCode, SpanKind } from '@opentelemetry/api';

interface OtelSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	operationName: string;
	startTime: number;
	endTime?: number;
	tags: Record<string, any>;
	logs: Array<{ timestamp: number; fields: Record<string, any> }>;
	status?: { code: SpanStatusCode; message?: string };
}

class CloudflareToOtelConverter {
	private spans: Map<string, OtelSpan> = new Map();
	private otelEndpoint: string;

	constructor(otelEndpoint = 'http://localhost:4318/v1/traces') {
		this.otelEndpoint = otelEndpoint;
	}

	handleEvent(event: TailStream.TailEvent<TailStream.EventType>) {

		switch (event.event.type) {
			case 'onset':
				this.handleOnset(event as TailStream.TailEvent<TailStream.Onset>);
				break;
			case 'spanOpen':
				this.handleSpanOpen(event as TailStream.TailEvent<TailStream.SpanOpen>);
				break;
			case 'attributes':
				this.handleAttributes(event as TailStream.TailEvent<TailStream.Attributes>);
				break;
			case 'log':
				this.handleLog(event as TailStream.TailEvent<TailStream.Log>);
				break;
			case 'spanClose':
				this.handleSpanClose(event as TailStream.TailEvent<TailStream.SpanClose>);
				break;
			case 'outcome':
				this.handleOutcome(event as TailStream.TailEvent<TailStream.Outcome>);
				break;
			case 'exception':
				this.handleException(event as TailStream.TailEvent<TailStream.Exception>);
				break;
			case 'return':
				this.handleReturn(event as TailStream.TailEvent<TailStream.Return>);
				break;
			case 'diagnosticChannel':
				this.handleDiagnosticChannel(event as TailStream.TailEvent<TailStream.DiagnosticChannelEvent>);
				break;
		}
	}

	private handleOnset(event: TailStream.TailEvent<TailStream.Onset>) {
		const { event: onset, spanContext, timestamp } = event;

		const span: OtelSpan = {
			traceId: spanContext.traceId,
			spanId: onset.spanId,
			// Onset is the root span - only has parent if there's an existing spanContext.spanId (from upstream)
			parentSpanId: spanContext.spanId || undefined,
			operationName: this.getOperationName(onset.info),
			startTime: timestamp.getTime() * 1000000,
			tags: this.extractTags(onset),
			logs: []
		};

		this.spans.set(span.spanId, span);
	}

	private handleSpanOpen(event: TailStream.TailEvent<TailStream.SpanOpen>) {
		const { event: spanOpen, spanContext, timestamp } = event;

		const span: OtelSpan = {
			traceId: spanContext.traceId,
			spanId: spanOpen.spanId,
			// spanContext.spanId is the parent span where this spanOpen occurred
			parentSpanId: spanContext.spanId,
			operationName: spanOpen.name,
			startTime: timestamp.getTime() * 1000000,
			tags: spanOpen.info ? this.extractSpanInfo(spanOpen.info) : {},
			logs: []
		};

		this.spans.set(span.spanId, span);
	}

	private handleAttributes(event: TailStream.TailEvent<TailStream.Attributes>) {
		const { event: attributes, spanContext } = event;
		// spanContext.spanId tells us which span to add attributes to
		const span = this.spans.get(spanContext.spanId!);

		if (span && attributes.info && Array.isArray(attributes.info)) {
			for (const attr of attributes.info) {
				span.tags[attr.name] = attr.value;
			}
		}
	}

	private handleLog(event: TailStream.TailEvent<TailStream.Log>) {
		const { event: log, spanContext, timestamp } = event;
		// spanContext.spanId tells us which span this log belongs to
		const span = this.spans.get(spanContext.spanId!);

		if (span) {
			span.logs.push({
				timestamp: timestamp.getTime() * 1000000,
				fields: {
					level: log.level,
					message: Array.isArray(log.message) ? log.message.join(' ') : log.message
				}
			});
		}
	}

	private handleSpanClose(event: TailStream.TailEvent<TailStream.SpanClose>) {
		const { timestamp, spanContext } = event;

		// spanContext.spanId tells us which span is being closed
		const span = this.spans.get(spanContext.spanId!);
		if (span) {
			span.endTime = timestamp.getTime() * 1000000;
			span.status = {
				code: event.event.outcome === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
				message: event.event.outcome
			};
		}
	}

	private handleException(event: TailStream.TailEvent<TailStream.Exception>) {
		const { event: exception, spanContext, timestamp } = event;
		// spanContext.spanId tells us which span this exception belongs to
		const span = this.spans.get(spanContext.spanId!);

		if (span) {
			span.logs.push({
				timestamp: timestamp.getTime() * 1000000,
				fields: {
					level: 'error',
					'exception.type': exception.name,
					'exception.message': exception.message,
					'exception.stacktrace': exception.stack || ''
				}
			});

			span.status = {
				code: SpanStatusCode.ERROR,
				message: exception.message
			};
		}
	}

	private handleReturn(event: TailStream.TailEvent<TailStream.Return>) {
		const { event: returnEvent, spanContext } = event;
		// spanContext.spanId tells us which span this return belongs to
		const span = this.spans.get(spanContext.spanId!);

		if (span && returnEvent.info?.type === 'fetch') {
			span.tags['http.response.status_code'] = returnEvent.info.statusCode;
		}
	}

	private handleDiagnosticChannel(event: TailStream.TailEvent<TailStream.DiagnosticChannelEvent>) {
		const { event: diagnostic, spanContext, timestamp } = event;
		// spanContext.spanId tells us which span this diagnostic belongs to
		const span = this.spans.get(spanContext.spanId!);

		if (span) {
			span.logs.push({
				timestamp: timestamp.getTime() * 1000000,
				fields: {
					level: 'debug',
					'diagnostic.channel': diagnostic.channel,
					'diagnostic.message': typeof diagnostic.message === 'string' ? diagnostic.message : JSON.stringify(diagnostic.message)
				}
			});
		}
	}

	private handleOutcome(event: TailStream.TailEvent<TailStream.Outcome>) {
		const { event: outcome, spanContext, timestamp } = event;

		// Outcome typically applies to the root span, but let's use spanContext if available
		// Otherwise, find the span without a parent (root span)
		const rootSpan = spanContext.spanId
			? this.spans.get(spanContext.spanId)
			: Array.from(this.spans.values()).find(span => !span.parentSpanId);

		if (rootSpan) {
			// IMPORTANT: Set the end time to close the onset span
			rootSpan.endTime = timestamp.getTime() * 1000000;

			rootSpan.status = {
				code: outcome.outcome === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
				message: outcome.outcome
			};

			rootSpan.tags['cpu.time.ms'] = outcome.cpuTime;
			rootSpan.tags['wall.time.ms'] = outcome.wallTime;
		}

		// Export all spans when the invocation completes
		this.exportSpans();
	}

	private getOperationName(info: TailStream.Onset['info']): string {
		switch (info.type) {
			case 'fetch':
				return `${info.method} ${info.url}`;
			case 'scheduled':
				return `scheduled:${info.cron}`;
			case 'queue':
				return `queue:${info.queueName}`;
			case 'email':
				return `email:${info.mailFrom}`;
			case 'jsrpc':
				return `rpc:${info.methodName}`;
			case 'alarm':
				return 'alarm';
			case 'custom':
				return 'custom';
			case 'trace':
				return 'trace';
			case 'hibernatableWebSocket':
				return `websocket:${info.info.type}`;
			default:
				return 'unknown';
		}
	}

	private extractTags(onset: TailStream.Onset): Record<string, any> {
		const tags: Record<string, any> = {
			'service.name': onset.scriptName || 'cloudflare-worker',
			'service.version': onset.scriptVersion?.id || 'unknown',
			'execution.model': onset.executionModel
		};

		if (onset.dispatchNamespace) {
			tags['dispatch.namespace'] = onset.dispatchNamespace;
		}
		if (onset.entrypoint) {
			tags['entrypoint'] = onset.entrypoint;
		}
		if (onset.scriptTags) {
			tags['script.tags'] = onset.scriptTags.join(',');
		}

		// Add event-specific tags
		const info = onset.info;
		if (info.type === 'fetch') {
			tags['http.method'] = info.method;
			tags['http.url'] = info.url;
			if (info.cfJson) {
				tags['cf.properties'] = JSON.stringify(info.cfJson);
			}
		} else if (info.type === 'scheduled') {
			tags['cron.expression'] = info.cron;
			tags['scheduled.time'] = info.scheduledTime.toISOString();
		} else if (info.type === 'queue') {
			tags['queue.name'] = info.queueName;
			tags['queue.batch_size'] = info.batchSize;
		}

		// Add attributes (check if attributes exists and is iterable)
		if (onset.attributes && Array.isArray(onset.attributes)) {
			for (const attr of onset.attributes) {
				tags[attr.name] = attr.value;
			}
		}

		return tags;
	}

	private extractSpanInfo(info: TailStream.SpanOpen['info']): Record<string, any> {
		if (!info) return {};

		if ('type' in info && info.type === 'fetch') {
			return {
				'http.method': info.method,
				'http.url': info.url
			};
		} else if ('type' in info && info.type === 'attributes') {
			const tags: Record<string, any> = {};
			if (info.info && Array.isArray(info.info)) {
				for (const attr of info.info) {
					tags[attr.name] = attr.value;
				}
			}
			return tags;
		}

		return {};
	}

	private async exportSpans() {
		const allSpans = Array.from(this.spans.values());

		if (allSpans.length === 0) return;

		await this.sendToOtel(allSpans);

		// Clean up all spans
		this.spans.clear();
	}

	private async sendToOtel(spans: OtelSpan[]) {
		const otelTrace = this.convertToOtelFormat(spans);

		try {
			await fetch(this.otelEndpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(otelTrace)
			});
		} catch (error) {
			console.error('Failed to export traces to OTEL endpoint:', error);
		}
	}

	private convertToOtelFormat(spans: OtelSpan[]) {
		return {
			resourceSpans: [{
				resource: {
					attributes: [
						{ key: 'service.name', value: { stringValue: 'cloudflare-worker' } },
						{ key: 'service.version', value: { stringValue: '1.0.0' } }
					]
				},
				scopeSpans: [{
					scope: {
						name: 'cloudflare-worker-tracer',
						version: '1.0.0'
					},
					spans: spans.map(span => ({
						traceId: this.padHex(span.traceId, 32),
						spanId: this.padHex(span.spanId, 16),
						parentSpanId: span.parentSpanId ? this.padHex(span.parentSpanId, 16) : undefined,
						name: span.operationName,
						kind: SpanKind.SERVER,
						startTimeUnixNano: span.startTime.toString(),
						endTimeUnixNano: span.endTime?.toString(),
						attributes: Object.entries(span.tags).map(([key, value]) => ({
							key,
							value: this.convertAttributeValue(value)
						})),
						events: span.logs.map(log => ({
							timeUnixNano: log.timestamp.toString(),
							name: 'log',
							attributes: Object.entries(log.fields).map(([key, value]) => ({
								key,
								value: this.convertAttributeValue(value)
							}))
						})),
						status: span.status ? {
							code: span.status.code,
							message: span.status.message
						} : undefined
					}))
				}]
			}]
		};
	}

	private convertAttributeValue(value: any): { [key: string]: any } {
		if (typeof value === 'string') {
			return { stringValue: value };
		} else if (typeof value === 'number') {
			if (Number.isInteger(value)) {
				return { intValue: value.toString() };
			} else {
				return { doubleValue: value };
			}
		} else if (typeof value === 'boolean') {
			return { boolValue: value };
		} else if (Array.isArray(value)) {
			return { arrayValue: { values: value.map((v: any) => this.convertAttributeValue(v)) } };
		} else {
			return { stringValue: String(value) };
		}
	}

	private padHex(hex: string, targetLength: number): string {
		// Ensure hex string is the correct length for OTEL (32 chars for traceId, 16 for spanId)
		return hex.padStart(targetLength, '0').toLowerCase();
	}
}

export default {
	async tail(events) {
		console.log(JSON.stringify(events));
	},

	tailStream(initialOnset: TailStream.TailEvent<TailStream.Onset>, env: Env, _ctx: ExecutionContext): TailStream.TailEventHandlerType {
		const converter = new CloudflareToOtelConverter(env.OTEL_ENDPOINT);

		// Handle the initial onset event immediately
		converter.handleEvent(initialOnset);

		return (event: TailStream.TailEvent<TailStream.EventType>) => {
			converter.handleEvent(event);
		};
	},

	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		console.log("Starting comprehensive Cloudflare bindings demo");

		const startTime = Date.now();
		const results = {
			timestamp: new Date().toISOString(),
			operations: [] as string[],
			timings: {} as Record<string, number>
		};

		try {
			// 1. KV Operations - Check cache first
			console.log("1. Checking KV cache");
			const cacheKey = 'demo:last-run';
			const lastRun = await env.CACHE_KV?.get(cacheKey);
			results.operations.push(`KV GET: ${cacheKey} = ${lastRun}`);

			// 2. External API call with caching
			console.log("2. Fetching external API data");
			let ipData;
			const ipCacheKey = 'demo:ip-data';
			const cachedIpData = await env.CACHE_KV?.get(ipCacheKey);

			if (cachedIpData) {
				console.log("Using cached IP data");
				ipData = JSON.parse(cachedIpData);
				results.operations.push("Using cached IP data");
			} else {
				console.log("Fetching fresh IP data");
				const response = await fetch("https://api.ipify.org?format=json");
				ipData = await response.json() as { ip: string };

				// Cache for 5 minutes
				await env.CACHE_KV?.put(ipCacheKey, JSON.stringify(ipData), { expirationTtl: 300 });
				results.operations.push(`Fetched fresh IP: ${ipData.ip}`);
			}

			// 3. D1 Database Operations
			console.log("3. Database operations");
			try {
				// Create table if not exists
				await env.DB?.prepare(`
					CREATE TABLE IF NOT EXISTS requests (
						id INTEGER PRIMARY KEY AUTOINCREMENT,
						ip TEXT,
						timestamp INTEGER,
						user_agent TEXT
					)
				`).run();

				// Insert current request
				const insertResult = await env.DB?.prepare(`
					INSERT INTO requests (ip, timestamp, user_agent)
					VALUES (?1, ?2, ?3)
				`).bind(
					ipData.ip,
					startTime,
					request.headers.get('User-Agent') || 'Unknown'
				).run();

				results.operations.push(`DB INSERT: ID ${insertResult?.meta?.last_row_id}`);

				// Query recent requests
				const recentRequests = await env.DB?.prepare(`
					SELECT COUNT(*) as count FROM requests
					WHERE timestamp > ?1
				`).bind(startTime - 3600000).first(); // Last hour

				results.operations.push(`DB SELECT: ${recentRequests?.count} requests in last hour`);
			} catch (dbError) {
				console.log("DB operations skipped (not configured)");
				results.operations.push("DB operations skipped (not configured)");
			}

			// 4. R2 Storage Operations
			console.log("4. R2 storage operations");
			try {
				const filename = `demo-${Date.now()}.json`;
				const demoData = {
					request_id: crypto.randomUUID(),
					timestamp: startTime,
					ip: ipData.ip,
					metadata: "Generated by Cloudflare Workers demo"
				};

				// Upload to R2
				await env.ASSETS?.put(filename, JSON.stringify(demoData, null, 2), {
					httpMetadata: {
						contentType: 'application/json'
					},
					customMetadata: {
						source: 'cloudflare-workers-demo',
						timestamp: startTime.toString()
					}
				});

				results.operations.push(`R2 PUT: ${filename}`);

				// List recent objects
				const listing = await env.ASSETS?.list({ limit: 5 });
				results.operations.push(`R2 LIST: ${listing?.objects?.length || 0} recent objects`);
			} catch (r2Error) {
				console.log("R2 operations skipped (not configured)");
				results.operations.push("R2 operations skipped (not configured)");
			}

			// 5. Queue Operations - Send analytics event
			console.log("5. Queue operations");
			try {
				const analyticsEvent = {
					type: 'demo_request',
					userId: 'demo-user',
					timestamp: startTime,
					data: {
						ip: ipData.ip,
						userAgent: request.headers.get('User-Agent'),
						path: new URL(request.url).pathname,
						operationCount: results.operations.length
					}
				};

				await env.ANALYTICS_QUEUE?.send(analyticsEvent);
				results.operations.push("QUEUE SEND: Analytics event queued");
			} catch (queueError) {
				console.log("Queue operations skipped (not configured)");
				results.operations.push("Queue operations skipped (not configured)");
			}

			// 6. Service Binding (if available)
			console.log("6. Service binding operations");
			try {
				if (env.AUTH_SERVICE) {
					const authResponse = await env.AUTH_SERVICE.fetch(new Request('https://auth/validate', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ token: 'demo-token' })
					}));

					const authResult = await authResponse.json();
					results.operations.push(`AUTH SERVICE: ${authResponse.status} - ${JSON.stringify(authResult)}`);
				} else {
					results.operations.push("AUTH SERVICE: Not configured");
				}
			} catch (authError) {
				results.operations.push("AUTH SERVICE: Error or not configured");
			}

			// 7. More KV operations - Update counters and cache
			console.log("7. Updating counters and cache");
			const counterKey = 'demo:request-count';
			const currentCount = await env.CACHE_KV?.get(counterKey);
			const newCount = (parseInt(currentCount || '0') + 1).toString();
			await env.CACHE_KV?.put(counterKey, newCount);
			await env.CACHE_KV?.put(cacheKey, startTime.toString(), { expirationTtl: 3600 });

			results.operations.push(`KV PUT: Request count = ${newCount}`);
			results.operations.push(`KV PUT: Last run timestamp cached`);

			// 8. Environment and runtime info
			console.log("8. Runtime information");
			results.operations.push(`Environment: ${env.ENVIRONMENT || 'development'}`);
			results.operations.push(`API Secret configured: ${!!env.API_SECRET}`);

			// Calculate total time
			const totalTime = Date.now() - startTime;
			results.timings.total_ms = totalTime;
			results.operations.push(`Total execution time: ${totalTime}ms`);

			console.log("Demo completed successfully");

			// Return comprehensive response
			return new Response(JSON.stringify({
				message: "Cloudflare Workers Bindings Demo - Complete!",
				summary: {
					operations_performed: results.operations.length,
					execution_time_ms: totalTime,
					ip_address: ipData.ip,
					request_count: newCount
				},
				details: results,
				trace_info: "Check Jaeger UI at http://localhost:16686 for detailed trace visualization"
			}, null, 2), {
				headers: {
					'Content-Type': 'application/json',
					'X-Demo-Operations': results.operations.length.toString(),
					'X-Demo-Time': totalTime.toString()
				}
			});

		} catch (error) {
			console.error("Demo failed:", error);
			return new Response(JSON.stringify({
				error: "Demo failed",
				message: error instanceof Error ? error.message : 'Unknown error',
				operations_completed: results.operations,
				partial_results: results
			}, null, 2), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	},

	// Queue consumer for analytics
	async queue(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log(`Processing ${batch.messages.length} analytics events`);

		// Ensure analytics table exists
		try {
			await env.DB?.prepare(`
				CREATE TABLE IF NOT EXISTS analytics (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					event_type TEXT,
					user_id TEXT,
					timestamp INTEGER,
					data TEXT
				)
			`).run();
		} catch (dbError) {
			console.log('Could not create analytics table (DB not configured)');
		}

		for (const message of batch.messages) {
			try {
				const event = message.body;
				console.log('Processing analytics event:', event.type);

				// Store in D1 database (with error handling)
				try {
					await env.DB?.prepare(`
						INSERT INTO analytics (event_type, user_id, timestamp, data)
						VALUES (?1, ?2, ?3, ?4)
					`).bind(event.type, event.userId, Date.now(), JSON.stringify(event.data)).run();
					console.log('Analytics event stored in DB');
				} catch (dbError) {
					console.log('DB storage failed (continuing with KV only):', dbError);
				}

				// Update KV counters
				try {
					const counterKey = `analytics:${event.type}:count`;
					const current = await env.CACHE_KV?.get(counterKey);
					const newCount = (parseInt(current || '0') + 1).toString();
					await env.CACHE_KV?.put(counterKey, newCount);
					console.log(`Updated analytics counter: ${event.type} = ${newCount}`);
				} catch (kvError) {
					console.log('KV update failed:', kvError);
				}

				message.ack();
			} catch (error) {
				console.error('Failed to process analytics event:', error);
				message.retry();
			}
		}
	},
} satisfies ExportedHandler<Env>;
