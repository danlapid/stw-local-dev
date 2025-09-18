/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
	async tail(events) {
		console.log(JSON.stringify(events));
	},
	tailStream(event, env, ctx) {
		console.log("onset")
		return (event) => {
			switch (event.event.type) {
			  case 'spanOpen':
				console.log("spanOpen", {
				  name: event.event.name,
				});
				break;
			  case 'attributes': {
				console.log("attributes")
				break;
			  }
			  case 'log': {
				console.log("log")
				break;
			  }
			  case 'spanClose': {
				console.log("spanClose")
				break;
			  }
			  case 'outcome':
				console.log("outcome")
				break;
			}
		  };
	},
	async fetch(request, env, ctx): Promise<Response> {
		console.log("fetch")
		let res = await fetch("https://api.ipify.org?format=json")
		let json = await res.json()

		return new Response(`Hello World! ${json.ip}`);
	},
} satisfies ExportedHandler<Env>;
