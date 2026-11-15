/* eslint-disable @typescript-eslint/no-require-imports -- The test loads the transpiled route with CommonJS mocks. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

process.env.STRIPE_SECRET_KEY = "sk_test_mock";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_mock";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test_service_key";

const source = fs.readFileSync(
  path.join(__dirname, "..", "app", "api", "webhook", "route.ts"),
  "utf8"
);
const javascript = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function createHandler({ event, session, signatureError, saveError } = {}) {
  const calls = { retrieved: [], saved: [] };
  class MockStripe {
    webhooks = {
      constructEvent() {
        if (signatureError) throw new Error("Invalid signature");
        return event;
      },
    };
    checkout = {
      sessions: {
        async retrieve(id) {
          calls.retrieved.push(id);
          return session;
        },
        async listLineItems() {
          return { data: [{ description: "Test book", quantity: 2 }] };
        },
      },
    };
  }
  const mockSupabase = {
    from(table) {
      assert.equal(table, "orders");
      return {
        async upsert(record, options) {
          calls.saved.push({ record, options });
          return { error: saveError || null };
        },
      };
    },
  };
  const moduleInstance = new Module("webhook-test", module);
  moduleInstance.filename = path.join(__dirname, "webhook-test.cjs");
  moduleInstance.paths = module.paths;
  moduleInstance.require = (id) => {
    if (id === "stripe") return MockStripe;
    if (id === "@supabase/supabase-js") {
      return { createClient: () => mockSupabase };
    }
    if (id === "next/server") {
      return { NextResponse: { json: (body, options) => ({ body, status: options?.status || 200 }) } };
    }
    return require(id);
  };
  moduleInstance._compile(javascript, moduleInstance.filename);
  return { post: moduleInstance.exports.POST, calls };
}

const paidSession = {
  id: "cs_test_order",
  payment_status: "paid",
  amount_total: 1998,
  currency: "usd",
  customer_details: { email: "customer@example.com", name: "Customer", phone: null },
  collected_information: {
    shipping_details: {
      name: "Recipient",
      address: { line1: "123 Main St", city: "Example" },
    },
  },
};

test("webhook retrieves current session and preserves existing orders on retries", async () => {
  const { post, calls } = createHandler({
    event: { type: "checkout.session.completed", data: { object: { id: paidSession.id } } },
    session: paidSession,
  });
  const response = await post(new Request("http://localhost/api/webhook", {
    method: "POST",
    headers: { "stripe-signature": "test" },
    body: "{}",
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls.retrieved, [paidSession.id]);
  assert.equal(calls.saved[0].record.shipping_name, "Recipient");
  assert.deepEqual(calls.saved[0].record.shipping_address, paidSession.collected_information.shipping_details.address);
  assert.deepEqual(calls.saved[0].record.items, [{ title: "Test book", quantity: 2 }]);
  assert.deepEqual(calls.saved[0].options, {
    onConflict: "stripe_session_id",
    ignoreDuplicates: true,
  });
});

test("unpaid checkout sessions do not create orders", async () => {
  const { post, calls } = createHandler({
    event: { type: "checkout.session.completed", data: { object: { id: paidSession.id } } },
    session: { ...paidSession, payment_status: "unpaid" },
  });
  const response = await post(new Request("http://localhost/api/webhook", {
    method: "POST",
    headers: { "stripe-signature": "test" },
    body: "{}",
  }));
  assert.equal(response.status, 200);
  assert.equal(calls.saved.length, 0);
});

test("unrelated events do not fetch sessions or create orders", async () => {
  const { post, calls } = createHandler({ event: { type: "charge.updated" } });
  const response = await post(new Request("http://localhost/api/webhook", {
    method: "POST",
    headers: { "stripe-signature": "test" },
    body: "{}",
  }));
  assert.equal(response.status, 200);
  assert.equal(calls.retrieved.length, 0);
  assert.equal(calls.saved.length, 0);
});
