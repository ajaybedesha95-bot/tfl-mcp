import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// TfL journey planner for Tooty's agents.
// Free TfL Unified API. Optional key: add a secret called TFL_APP_KEY in Cloudflare.

const TFL = "https://api.tfl.gov.uk/Journey/JourneyResults";

type Opt = { parameterValue: string; place?: { commonName?: string } };

function pickBest(dis: any): string | null {
	const opts: Opt[] = dis?.disambiguationOptions ?? [];
	return opts.length ? opts[0].parameterValue : null;
}

async function callTfl(from: string, to: string, params: URLSearchParams) {
	const url = `${TFL}/${encodeURIComponent(from)}/to/${encodeURIComponent(to)}?${params}`;
	const res = await fetch(url, { headers: { "User-Agent": "tfl-mcp" } });
	const body: any = await res.json().catch(() => ({}));
	return { status: res.status, body };
}

function fmtTime(iso: string) {
	return iso ? iso.slice(11, 16) : "?";
}

function summarise(body: any, from: string, to: string): string {
	const journeys: any[] = body?.journeys ?? [];
	if (!journeys.length) return `No journeys found from ${from} to ${to}.`;
	const lines = [`Journeys from ${from} to ${to}:`];
	journeys.slice(0, 3).forEach((j, i) => {
		lines.push(
			`\nOption ${i + 1}: ${j.duration} min, depart ${fmtTime(j.startDateTime)}, arrive ${fmtTime(j.arrivalDateTime)}`,
		);
		for (const leg of j.legs ?? []) {
			const mode = leg.mode?.name ?? "?";
			const what = leg.instruction?.summary ?? "";
			lines.push(`  - ${leg.duration} min ${mode}: ${what}`);
		}
	});
	return lines.join("\n");
}

export class MyMCP extends McpAgent {
	server = new McpServer({ name: "TfL journey planner", version: "1.0.0" });

	async init() {
		this.server.tool(
			"plan_journey",
			"Real TfL journey times in London and the South East (tube, rail, bus, walking). Use for travel blocks and departure times. Places can be station names, postcodes or 'lat,lon'.",
			{
				from: z.string().describe("Start, e.g. 'East Croydon' or a postcode"),
				to: z.string().describe("Destination, e.g. 'Tottenham Court Road' or a postcode"),
				date: z.string().optional().describe("Date as YYYYMMDD; default today"),
				time: z.string().optional().describe("Time as HHMM, 24-hour"),
				arriveBy: z.boolean().optional().describe("true = time is the arrival time; false = departure time"),
				walkingOnly: z.boolean().optional().describe("true = walking route only"),
			},
			async ({ from, to, date, time, arriveBy, walkingOnly }) => {
				const params = new URLSearchParams();
				if (date) params.set("date", date);
				if (time) params.set("time", time);
				if (time) params.set("timeIs", arriveBy ? "Arriving" : "Departing");
				if (walkingOnly) params.set("mode", "walking");
				const key = (this.env as any)?.TFL_APP_KEY;
				if (key) params.set("app_key", key);

				let f = from;
				let t = to;
				let r = await callTfl(f, t, params);

				// TfL returns 300 when a place name is ambiguous: pick the best match and retry once.
				if (r.status === 300) {
					f = pickBest(r.body?.fromLocationDisambiguation) ?? f;
					t = pickBest(r.body?.toLocationDisambiguation) ?? t;
					r = await callTfl(f, t, params);
				}

				const text =
					r.status === 200
						? summarise(r.body, from, to)
						: `TfL error ${r.status}: ${r.body?.message ?? "no journeys found"}. Try a station name or postcode.`;
				return { content: [{ type: "text", text }] };
			},
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}
		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}
		return new Response("TfL MCP is running. Connect to /mcp", { status: 200 });
	},
};
