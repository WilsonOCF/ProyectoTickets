require("dotenv").config();
const { Agent } = require("@cursor/sdk");

(async () => {
  const agent = await Agent.create({
    apiKey: process.env.CURSOR_API_KEY,
    model: { id: "auto" },
    tools: [],
    local: { cwd: process.cwd(), settingSources: [] },
  });
  try {
    const run = await agent.send({
      text: 'Respondé SOLO con este JSON exacto: {"project":"TI","name":"ping","priority":"low","summary":"ok","description_html":"<p>ok</p>"}',
    });
    const result = await run.wait();
    console.log(
      JSON.stringify(
        {
          status: result.status,
          model: result.model,
          result: (result.result || "").slice(0, 400),
          error: result.error,
        },
        null,
        2
      )
    );
  } finally {
    await agent[Symbol.asyncDispose]?.();
  }
})().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
