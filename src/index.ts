import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

// TfL journey planner for Tooty's agents.
// Free TfL Unified API. Key comes from the Cloudflare secret TFL_APP_KEY.

const TFL = "https://api.tfl.gov.uk/Journey/JourneyResults";

type Opt = { parameterValue: string; place?: { commonName?: string } };

function pickBest(dis: any): string | null {
	const opts: Opt[] = dis?.disambiguationOptions ?? [];
	return opts.length ? opts[0].parameterValue : null;
}

async function callTfl(from: string, to: string, params: URLSearchParams) {
	params.set("nationalSearch", "true");
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
	const lines = [`Journeys from ${from} to ${to}, fastest first:`];
	[...journeys].sort((a, b) => a.duration - b.duration).slice(0, 5).forEach((j, i) => {
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

function createServer(key?: string) {
	const server = new McpServer({ name: "TfL journey planner", version: "1.0.0" });

	server.registerTool(
		"plan_journey",
		{
			description:
				"Real TfL journey times in London and the South East (tube, rail, bus, walking). Use for travel blocks and departure times. Places can be station names, postcodes or 'lat,lon'.",
			inputSchema: z.object({
				from: z.string().describe("Start, e.g. 'East Croydon' or a postcode"),
				to: z.string().describe("Destination, e.g. 'Tottenham Court Road' or a postcode"),
				date: z.string().optional().describe("Date as YYYYMMDD; default today"),
				time: z.string().optional().describe("Time as HHMM, 24-hour"),
				arriveBy: z.boolean().optional().describe("true = time is the arrival time; false = departure time"),
				walkingOnly: z.boolean().optional().describe("true = walking route only"),
			}),
		},
		async ({ from, to, date, time, arriveBy, walkingOnly }) => {
			const params = new URLSearchParams();
			if (date) params.set("date", date);
			if (time) params.set("time", time);
			if (time) params.set("timeIs", arriveBy ? "Arriving" : "Departing");
			if (walkingOnly) params.set("mode", "walking");
			if (key) params.set("app_key", key);

			let r = await callTfl(from, to, params);

			// TfL returns 300 when a place name is ambiguous: pick the best match and retry once.
			if (r.status === 300) {
				const f = pickBest(r.body?.fromLocationDisambiguation) ?? from;
				const t = pickBest(r.body?.toLocationDisambiguation) ?? to;
				r = await callTfl(f, t, params);
			}

			const text =
				r.status === 200
					? summarise(r.body, from, to)
					: `TfL error ${r.status}: ${r.body?.message ?? "no journeys found"}. Try a station name or postcode.`;
			return { content: [{ type: "text", text }] };
		},
	);

	return server;
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const key = (env as any).TFL_APP_KEY as string | undefined;
		return createMcpHandler(() => createServer(key))(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
