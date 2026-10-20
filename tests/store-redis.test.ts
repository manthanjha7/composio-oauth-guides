import { afterEach, describe, expect, it, vi } from "vitest";

describe("Upstash Redis store", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("saves, reads back and lists a live guide over the REST API", async () => {
    vi.stubEnv("KV_REST_API_URL", "https://redis.example");
    vi.stubEnv("KV_REST_API_TOKEN", "t");
    const db = new Map<string, string>();
    const index = new Set<string>();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const [cmd, ...args] = JSON.parse(init.body) as string[];
        let result: unknown = null;
        if (cmd === "SET") db.set(args[0], args[1]);
        if (cmd === "GET") result = db.get(args[0]) ?? null;
        if (cmd === "SADD") index.add(args[1]);
        if (cmd === "SMEMBERS") result = [...index];
        if (cmd === "MGET") result = args.map((k) => db.get(k) ?? null);
        return new Response(JSON.stringify({ result }), { status: 200 });
      }),
    );
    const store = await import("@/lib/store");
    const seed = (await store.listSeedGuides())[0];
    const record = { ...seed, slug: "acme-test", meta: { ...seed.meta, origin: "live" as const } };
    expect(store.storageMode()).toBe("redis");
    await store.saveGuide(record);
    expect((await store.getGuide("acme-test"))?.slug).toBe("acme-test");
    expect((await store.listLiveGuides()).map((g) => g.slug)).toEqual(["acme-test"]);
  });
});
