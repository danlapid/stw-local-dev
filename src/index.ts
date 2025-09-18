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
	private rootSpanId?: string;
	private activeSpanStack: string[] = []; // Stack to track currently active spans

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
		this.rootSpanId = span.spanId;
		this.activeSpanStack.push(span.spanId);
	}

	private handleSpanOpen(event: TailStream.TailEvent<TailStream.SpanOpen>) {
		const { event: spanOpen, spanContext, timestamp } = event;

		const span: OtelSpan = {
			traceId: spanContext.traceId,
			spanId: spanOpen.spanId,
			// SpanOpen creates child spans - parent is the current active span (usually the onset span)
			parentSpanId: this.activeSpanStack[this.activeSpanStack.length - 1] || spanContext.spanId,
			operationName: spanOpen.name,
			startTime: timestamp.getTime() * 1000000,
			tags: spanOpen.info ? this.extractSpanInfo(spanOpen.info) : {},
			logs: []
		};

		this.spans.set(span.spanId, span);
		this.activeSpanStack.push(span.spanId);
	}

	private handleAttributes(event: TailStream.TailEvent<TailStream.Attributes>) {
		const { event: attributes, spanContext } = event;
		// Use spanContext.spanId if available, otherwise use the current active span
		const targetSpanId = spanContext.spanId || this.activeSpanStack[this.activeSpanStack.length - 1];
		const span = this.spans.get(targetSpanId);

		if (span) {
			for (const attr of attributes.info) {
				span.tags[attr.name] = attr.value;
			}
		}
	}

	private handleLog(event: TailStream.TailEvent<TailStream.Log>) {
		const { event: log, spanContext, timestamp } = event;
		// Use spanContext.spanId if available, otherwise use the current active span
		const targetSpanId = spanContext.spanId || this.activeSpanStack[this.activeSpanStack.length - 1];
		const span = this.spans.get(targetSpanId);

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
		const { timestamp } = event;

		// SpanClose closes the most recently opened span
		const spanId = this.activeSpanStack.pop();
		if (!spanId) return;

		const span = this.spans.get(spanId);
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
		// Use spanContext.spanId if available, otherwise use the current active span
		const targetSpanId = spanContext.spanId || this.activeSpanStack[this.activeSpanStack.length - 1];
		const span = this.spans.get(targetSpanId);

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
		// Use spanContext.spanId if available, otherwise use the current active span
		const targetSpanId = spanContext.spanId || this.activeSpanStack[this.activeSpanStack.length - 1];
		const span = this.spans.get(targetSpanId);

		if (span && returnEvent.info?.type === 'fetch') {
			span.tags['http.response.status_code'] = returnEvent.info.statusCode;
		}
	}

	private handleDiagnosticChannel(event: TailStream.TailEvent<TailStream.DiagnosticChannelEvent>) {
		const { event: diagnostic, spanContext, timestamp } = event;
		// Use spanContext.spanId if available, otherwise use the current active span
		const targetSpanId = spanContext.spanId || this.activeSpanStack[this.activeSpanStack.length - 1];
		const span = this.spans.get(targetSpanId);

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
		const { event: outcome } = event;
		const rootSpan = this.rootSpanId ? this.spans.get(this.rootSpanId) : undefined;

		if (rootSpan) {
			rootSpan.status = {
				code: outcome.outcome === 'ok' ? SpanStatusCode.OK : SpanStatusCode.ERROR,
				message: outcome.outcome
			};

			rootSpan.tags['cpu.time.ms'] = outcome.cpuTime;
			rootSpan.tags['wall.time.ms'] = outcome.wallTime;
		}

		// Export all completed spans
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

		// Add attributes
		for (const attr of onset.attributes) {
			tags[attr.name] = attr.value;
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
			for (const attr of info.info) {
				tags[attr.name] = attr.value;
			}
			return tags;
		}

		return {};
	}

	private async exportSpans() {
		const completedSpans = Array.from(this.spans.values()).filter(span => span.endTime);

		if (completedSpans.length === 0) return;

		const otelTrace = this.convertToOtelFormat(completedSpans);

		try {
			await fetch(this.otelEndpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(otelTrace)
			});

			// Clean up exported spans
			completedSpans.forEach(span => this.spans.delete(span.spanId));
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

	private convertAttributeValue(value: any) {
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
			return { arrayValue: { values: value.map(v => this.convertAttributeValue(v)) } };
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

	tailStream(_event: TailStream.TailEvent<TailStream.Onset>, env: Env, _ctx: ExecutionContext): TailStream.TailEventHandlerType {
		const converter = new CloudflareToOtelConverter(env.OTEL_ENDPOINT);

		return (event: TailStream.TailEvent<TailStream.EventType>) => {
			converter.handleEvent(event);
		};
	},

	async fetch(_request: Request, _env: Env, _ctx: any): Promise<Response> {
		console.log("fetch")
		let res = await fetch("https://api.ipify.org?format=json")
		let json = await res.json() as { ip: string }

		return new Response(`Hello World! ${json.ip}`);
	},
} satisfies ExportedHandler<Env>;
