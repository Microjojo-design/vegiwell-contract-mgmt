// 合約 PDF AI 辨識填表 — Supabase Edge Function
// 部署:npx supabase functions deploy contract-extract --project-ref dqxdgxbebumxtbyvbxkn
// 密鑰:npx supabase secrets set ANTHROPIC_API_KEY=sk-ant-... --project-ref dqxdgxbebumxtbyvbxkn
import Anthropic from "npm:@anthropic-ai/sdk";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const CO_VALUES = ["xiaori", "xiangyue", "shixin", "gaoshu"];
const ROLE_VALUES = ["party_a", "party_b", "both", "none"];
const CURRENCY_VALUES = ["NTD", "USD", "CNY"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

const nullableString = { type: ["string", "null"] };
const nullableDate = {
  anyOf: [{ type: "string", format: "date" }, { type: "null" }],
};

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title", "co", "category_code", "party_a", "party_b", "party_b_contact",
    "our_party_role", "start_date", "end_date", "amount", "currency",
    "officer", "officer_email", "notes", "needs_review",
  ],
  properties: {
    title: nullableString,
    co: { anyOf: [{ type: "string", enum: CO_VALUES }, { type: "null" }] },
    category_code: nullableString,
    party_a: nullableString,
    party_b: nullableString,
    party_b_contact: nullableString,
    our_party_role: { anyOf: [{ type: "string", enum: ROLE_VALUES }, { type: "null" }] },
    start_date: nullableDate,
    end_date: nullableDate,
    amount: { type: ["number", "null"] },
    currency: { anyOf: [{ type: "string", enum: CURRENCY_VALUES }, { type: "null" }] },
    officer: nullableString,
    officer_email: nullableString,
    notes: nullableString,
    needs_review: { type: "array", items: { type: "string" } },
  },
};

function buildSystemPrompt(categories: { code: string; name: string }[]): string {
  const catList = categories.map((c) => `- ${c.code}(${c.name})`).join("\n");
  return `你是集團合約管理系統的資料抽取助手。使用者上傳合約 PDF,你負責抽取欄位供前端自動填表,使用者會再人工確認。

公司代碼(co):
- xiaori(小日常)
- xiangyue(翔悅建設)
- shixin(蒔心田生醫)
- gaoshu(高速駕訓班)

可用分類代碼(category_code,只能從此清單選,選不出就填 null):
${catList}

判斷規則:
1. 合約標題或內容包含「蒔心田生醫」→ co 填 shixin。
2. 內容包含「網紅」「口碑」「KOL」「KOC」「Reels」「IG」等字眼 → category_code 優先選 kolkoc(若清單中存在)。
3. 甲方是蒔心田生醫有限公司 → our_party_role 填 party_a;其他情況依我方公司在合約中的角色判斷,判斷不了填 null。
4. 產品交換、互惠、0 元合作 → amount 填 0,並在 notes 清楚寫出酬勞內容(例如提供之產品與數量)。
5. 日期一律轉為 YYYY-MM-DD;民國年要換算西元(民國114年=2026年)。只找得到年月時填 null 並列入 needs_review。
6. title 用簡潔可辨識的合約名稱(例如「張婷軒 KOL 合作合約」),不要照抄冗長全名。
7. party_b_contact 填對方聯絡人姓名/電話/email(合約內有才填)。
8. officer / officer_email 是我方承辦人,合約內通常沒有,沒有就填 null,不要虛構。
9. 金額只填數字(不含幣別符號與逗號);幣別放 currency,判斷不了幣別但金額是新台幣語境則填 NTD。
10. 任何不確定或推測成分高的欄位:填 null,並把欄位名加進 needs_review 陣列。寧可留空,絕不編造。`;
}

// deno-lint-ignore no-explicit-any
function validateExtract(data: any): { data: Record<string, unknown>; problems: string[] } {
  const problems: string[] = [];
  const out: Record<string, unknown> = {};
  const str = (k: string) => {
    const v = data?.[k];
    out[k] = typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };
  ["title", "category_code", "party_a", "party_b", "party_b_contact", "officer", "officer_email", "notes"].forEach(str);

  const enumField = (k: string, allowed: string[]) => {
    const v = data?.[k];
    if (v != null && !allowed.includes(v)) {
      problems.push(`${k} 值 ${v} 不在允許清單,已忽略`);
      out[k] = null;
    } else out[k] = v ?? null;
  };
  enumField("co", CO_VALUES);
  enumField("our_party_role", ROLE_VALUES);
  enumField("currency", CURRENCY_VALUES);

  for (const k of ["start_date", "end_date"]) {
    const v = data?.[k];
    if (v != null && !DATE_RE.test(v)) {
      problems.push(`${k} 格式不正確(${v}),已忽略`);
      out[k] = null;
    } else out[k] = v ?? null;
  }

  const amt = data?.amount;
  out.amount = typeof amt === "number" && isFinite(amt) && amt >= 0 ? amt : null;

  out.needs_review = Array.isArray(data?.needs_review)
    ? data.needs_review.filter((x: unknown) => typeof x === "string").slice(0, 20)
    : [];
  return { data: out, problems };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });

  // 驗證登入使用者(anon key 的 JWT 過得了 gateway,但這裡要求真實使用者 session)
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { Authorization: authHeader, apikey: anonKey },
  });
  if (!userRes.ok) return json(401, { ok: false, error: "請先登入再使用 AI 辨識" });
  const user = await userRes.json();
  if (!user?.id) return json(401, { ok: false, error: "請先登入再使用 AI 辨識" });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json(500, { ok: false, error: "伺服器未設定 ANTHROPIC_API_KEY" });

  let body: { pdf_base64?: string; filename?: string; categories?: { code: string; name: string }[] };
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "請求格式錯誤" });
  }
  const pdfBase64 = (body.pdf_base64 ?? "").replace(/\s/g, "");
  if (!pdfBase64) return json(400, { ok: false, error: "缺少 pdf_base64" });
  if (pdfBase64.length * 0.75 > MAX_PDF_BYTES) {
    return json(413, { ok: false, error: "PDF 超過 15MB,請壓縮後再試" });
  }
  const categories = (body.categories ?? [])
    .filter((c) => c && typeof c.code === "string" && typeof c.name === "string")
    .slice(0, 50);

  const client = new Anthropic({ apiKey });
  let response;
  try {
    response = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      thinking: { type: "adaptive" },
      system: buildSystemPrompt(categories),
      output_config: { format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
              title: body.filename ?? "contract.pdf",
            },
            { type: "text", text: "請閱讀這份合約,依系統指示抽取欄位並輸出 JSON。" },
          ],
        },
      ],
    });
  } catch (err) {
    console.error("anthropic error:", err);
    return json(502, { ok: false, error: "AI 辨識服務暫時無法使用,請稍後再試" });
  }

  if (response.stop_reason === "refusal") {
    return json(422, { ok: false, error: "AI 拒絕處理此文件,請人工填寫" });
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) return json(502, { ok: false, error: "AI 未回傳結果,請稍後再試" });

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(502, { ok: false, error: "AI 回傳格式無法解析,請稍後再試" });
  }
  const { data, problems } = validateExtract(parsed);
  return json(200, { ok: true, data, problems, model: response.model });
});
