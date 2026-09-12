export interface Env {
  GEMINI_BL: string;
  DEFAULT_MODEL?: string;
  REQUEST_TIMEOUT_SEC?: string;
  API_KEYS?: string;
  COOKIE?: string;
  SAPISID?: string;
  AUTH_USER?: string;
  XSRF_TOKEN?: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

export function accountPrefix(env: Env): string {
  const u = env.AUTH_USER;
  if (u === undefined || u === null || u === "") return "";
  return `/u/${u}`;
}

function parseSapisid(cookie: string): string | null {
  for (const pair of cookie.split("; ")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;

    if (pair.slice(0, eq) === "SAPISID") {
      return pair.slice(eq + 1);
    }
  }

  return null;
}

export async function makeSapisidHash(
  sapisid: string,
): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);

  const data = new TextEncoder().encode(
    `${ts} ${sapisid} https://gemini.google.com`,
  );

  const digest = await crypto.subtle.digest("SHA-1", data);

  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return `SAPISIDHASH ${ts}_${hex}`;
}

async function buildHeaders(
  env: Env,
): Promise<Record<string, string>> {
  const prefix = accountPrefix(env);

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://gemini.google.com",
    Referer: `https://gemini.google.com${prefix}/app`,
    "X-Same-Domain": "1",
    "User-Agent": USER_AGENT,
  };

  if (prefix) {
    headers["X-Goog-AuthUser"] = String(env.AUTH_USER);
  }

  const cookie = env.COOKIE;

  if (cookie) {
    headers["Cookie"] = cookie;

    const sapisid =
      env.SAPISID || parseSapisid(cookie);

    if (sapisid) {
      headers["Authorization"] =
        await makeSapisidHash(sapisid);
    }
  }

  return headers;
}

function buildPayload(
  prompt: string,
  modeId: number,
  thinkMode: number,
  fileRefs: string[] | null,
  extra: Record<number, unknown> | undefined,
  xsrfToken: string | undefined,
): string {
  const inner: unknown[] = new Array(102).fill(null);

  if (fileRefs && fileRefs.length) {
    const refs = fileRefs.map((ref) => [
      null,
      null,
      ref,
    ]);

    inner[0] = [
      prompt,
      0,
      null,
      refs,
      null,
      null,
      0,
    ];
  } else {
    inner[0] = [
      prompt,
      0,
      null,
      null,
      null,
      null,
      0,
    ];
  }

  inner[1] = ["en"];

  inner[2] = [
    "",
    "",
    "",
    null,
    null,
    null,
    null,
    null,
    null,
    "",
  ];

  inner[6] = [0];
  inner[7] = 1;
  inner[10] = 1;
  inner[11] = 0;
  inner[17] = [[thinkMode]];
  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [2];
  inner[53] = 0;
  inner[59] = crypto.randomUUID();
  inner[61] = [];
  inner[68] = 1;
  inner[79] = modeId;

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      inner[Number(k)] = v;
    }
  }

  const outer = [
    null,
    JSON.stringify(inner),
  ];

  const params = new URLSearchParams();

  params.set(
    "f.req",
    JSON.stringify(outer),
  );

  if (xsrfToken) {
    params.set("at", xsrfToken);
  }

  return params.toString();
}

function getUrl(env: Env): string {
  const reqid =
    Math.floor(Date.now() / 1000) % 1000000;

  const prefix = accountPrefix(env);

  return (
    `https://gemini.google.com${prefix}/_/BardChatUi/data/` +
    "assistant.lamda.BardFrontendService/StreamGenerate" +
    `?bl=${env.GEMINI_BL}` +
    `&hl=en` +
    `&_reqid=${reqid}` +
    `&rt=c`
  );
}

function cleanText(text: string): string {
  text = text.replace(
    /```(?:python|javascript|text)\?code_(?:reference|stdout)&code_event_index=\d+\n[\s\S]*?```\n?/g,
    "",
  );

  text = text.replace(
    /http:\/\/googleusercontent\.com\/card_content\/\d+\n?/g,
    "",
  );

  return text.trim();
}

function extractTextsFromLine(
  line: string,
): string[] {
  if (
    !line.includes('"wrb.fr"') ||
    line.length < 200
  ) {
    return [];
  }

  try {
    const arr = JSON.parse(line);

    const innerStr = arr?.[0]?.[2];

    if (
      !innerStr ||
      typeof innerStr !== "string" ||
      innerStr.length < 50
    ) {
      return [];
    }

    const inner = JSON.parse(innerStr);

    if (
      !Array.isArray(inner) ||
      inner.length <= 4 ||
      !inner[4]
    ) {
      return [];
    }

    const texts: string[] = [];

    for (const part of inner[4]) {
      if (
        Array.isArray(part) &&
        part.length > 1 &&
        Array.isArray(part[1])
      ) {
        for (const t of part[1]) {
          if (
            typeof t === "string" &&
            t
          ) {
            texts.push(t);
          }
        }
      }
    }

    return texts;
  } catch {
    return [];
  }
}

export function extractResponseText(
  raw: string,
): string {
  let last = "";

  for (const line of raw.split("\n")) {
    for (
      const t of extractTextsFromLine(line)
    ) {
      if (t.length > last.length) {
        last = t;
      }
    }
  }

  return cleanText(last);
}

const sleep = (
  ms: number,
) =>
  new Promise<void>((resolve) =>
    setTimeout(resolve, ms),
  );

async function postGemini(
  prompt: string,
  modeId: number,
  thinkMode: number,
  fileRefs: string[] | null,
  extra: Record<number, unknown> | undefined,
  env: Env,
): Promise<Response> {
  const body = buildPayload(
    prompt,
    modeId,
    thinkMode,
    fileRefs,
    extra,
    env.XSRF_TOKEN,
  );

  const url = getUrl(env);
  const headers = await buildHeaders(env);

  const timeoutMs =
    (Number(env.REQUEST_TIMEOUT_SEC) || 180) *
    1000;

  let lastErr: unknown;

  for (
    let attempt = 0;
    attempt < RETRY_ATTEMPTS;
    attempt++
  ) {
    try {
      return await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(
          timeoutMs,
        ),
      });
    } catch (e) {
      lastErr = e;

      if (
        attempt <
        RETRY_ATTEMPTS - 1
      ) {
        await sleep(
          RETRY_DELAY_MS,
        );
      }
    }
  }

  throw lastErr;
}

export async function generate(
  prompt: string,
  modeId: number,
  thinkMode: number,
  fileRefs: string[] | null,
  extra: Record<number, unknown> | undefined,
  env: Env,
): Promise<string> {
  const resp = await postGemini(
    prompt,
    modeId,
    thinkMode,
    fileRefs,
    extra,
    env,
  );

  return extractResponseText(
    await resp.text(),
  );
}

export async function* generateStream(
  prompt: string,
  modeId: number,
  thinkMode: number,
  fileRefs: string[] | null,
  extra: Record<number, unknown> | undefined,
  env: Env,
): AsyncGenerator<string> {
  const resp = await postGemini(
    prompt,
    modeId,
    thinkMode,
    fileRefs,
    extra,
    env,
  );

  if (!resp.body) {
    const text =
      extractResponseText(
        await resp.text(),
      );

    if (text) {
      yield text;
    }

    return;
  }

  const reader = resp.body
    .pipeThrough(
      new TextDecoderStream(),
    )
    .getReader();

  let buf = "";
  let prevText = "";

  const emitTexts = function* (
    texts: string[],
  ): Generator<string> {
    for (const t of texts) {
      if (
        t.length <=
        prevText.length
      ) {
        continue;
      }

      const delta = cleanText(
        t.slice(
          prevText.length,
        ),
      );

      if (delta) {
        yield delta;
      }

      prevText = t;
    }
  };

  try {
    while (true) {
      const {
        done,
        value,
      } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      buf += value;

      /*
       * 正常情况下 Gemini 使用换行分隔响应
       */
      while (true) {
        const nl =
          buf.indexOf("\n");

        if (nl === -1) {
          break;
        }

        const line =
          buf.slice(0, nl);

        buf =
          buf.slice(nl + 1);

        const texts =
          extractTextsFromLine(
            line,
          );

        for (
          const delta of emitTexts(
            texts,
          )
        ) {
          yield delta;
        }
      }

      /*
       * 某些情况下 Gemini 不会马上
       * 发送换行符。
       *
       * 如果当前 buffer 已经包含
       * 完整的 wrb.fr 响应，则立即尝试解析
       */
      if (
        buf.includes('"wrb.fr"') &&
        buf.length >= 200
      ) {
        const texts =
          extractTextsFromLine(
            buf,
          );

        if (texts.length > 0) {
          for (
            const delta of emitTexts(
              texts,
            )
          ) {
            yield delta;
          }

          /*
           * 已经成功解析的数据清空
           */
          buf = "";
        }
      }
    }

    /*
     * 最后一段可能没有换行
     */
    if (buf.trim()) {
      const texts =
        extractTextsFromLine(
          buf,
        );

      for (
        const delta of emitTexts(
          texts,
        )
      ) {
        yield delta;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}

    reader.releaseLock();
  }
}
