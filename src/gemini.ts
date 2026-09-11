// Gemini Web StreamGenerate protocol, ported from gemini-web2api's gemini.py.
// This is the load-bearing reverse-engineered layer: the positional payload
// array and the `wrb.fr` response parsing mirror the Python implementation.

export interface Env {
  GEMINI_BL: string;
  DEFAULT_MODEL?: string;
  REQUEST_TIMEOUT_SEC?: string;

  /** Comma-separated API keys. Empty/unset → auth disabled. */
  API_KEYS?: string;

  /** Full Cookie header string (secret). Enables authenticated routing. */
  COOKIE?: string;

  /** Explicit SAPISID override; otherwise parsed from COOKIE. */
  SAPISID?: string;

  /** Google account index for /u/<index>/ routing. */
  AUTH_USER?: string;

  /** Page XSRF token (SNlM0e), sent as the `at` form field. */
  XSRF_TOKEN?: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

/**
 * If Gemini has already produced text but keeps the HTTP connection open,
 * stop waiting after this amount of inactivity.
 *
 * This is specifically intended to fix Gemini Web occasionally leaving
 * StreamGenerate open after the final useful response has arrived.
 */
const STREAM_IDLE_TIMEOUT_MS = 8000;

export function accountPrefix(env: Env): string {
  const u = env.AUTH_USER;

  if (u === undefined || u === null || u === "") {
    return "";
  }

  return `/u/${u}`;
}

function parseSapisid(cookie: string): string | null {
  for (const pair of cookie.split("; ")) {
    const eq = pair.indexOf("=");

    if (eq === -1) {
      continue;
    }

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
  // Sparse positional array — indices carry meaning
  // (see models.ts / README).
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

  // thinking depth:
  // 0 = deepest
  // 4 = shallowest
  inner[17] = [[thinkMode]];

  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [2];
  inner[53] = 0;
  inner[59] = crypto.randomUUID();
  inner[61] = [];
  inner[68] = 1;

  // MODE_CATEGORY model selector
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
    `?bl=${env.GEMINI_BL}&hl=en&_reqid=${reqid}&rt=c`
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

/**
 * Parse a single wrb.fr line and return the text strings found.
 */
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
      !(
        Array.isArray(inner) &&
        inner.length > 4 &&
        inner[4]
      )
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

/**
 * Parse the full StreamGenerate response,
 * returning the longest text found.
 */
export function extractResponseText(
  raw: string,
): string {
  let last = "";

  for (const line of raw.split("\n")) {
    for (const t of extractTextsFromLine(line)) {
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

/**
 * Read a Response body line-by-line.
 *
 * Returns all text accumulated before the upstream connection closes
 * or becomes idle after useful content has already been received.
 *
 * Important:
 * We never have two simultaneous reader.read() calls.
 * A timeout always cancels the reader before returning.
 */
async function readResponseWithIdleTimeout(
  resp: Response,
  idleTimeoutMs: number,
): Promise<string> {
  if (!resp.body) {
    return extractResponseText(
      await resp.text(),
    );
  }

  const reader = resp.body
    .pipeThrough(new TextDecoderStream())
    .getReader();

  let buffer = "";
  let longestText = "";
  let receivedText = false;

  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const readPromise = reader.read();

      const timeoutPromise =
        new Promise<{
          timeout: true;
        }>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              timeout: true,
            });
          }, idleTimeoutMs);
        });

      const result = await Promise.race([
        readPromise.then((value) => ({
          timeout: false as const,
          value,
        })),
        timeoutPromise,
      ]);

      if (timer !== undefined) {
        clearTimeout(timer);
      }

      if (result.timeout) {
        if (receivedText) {
          break;
        }

        /*
         * No useful response yet.
         *
         * Do not immediately give up. Continue waiting until the
         * normal Worker request timeout handles a genuinely dead
         * upstream connection.
         */
        continue;
      }

      const { done, value } =
        result.value;

      if (done) {
        break;
      }

      buffer += value;

      let newlineIndex: number;

      while (
        (newlineIndex =
          buffer.indexOf("\n")) !== -1
      ) {
        const line =
          buffer.slice(
            0,
            newlineIndex,
          );

        buffer =
          buffer.slice(
            newlineIndex + 1,
          );

        for (
          const text of
            extractTextsFromLine(line)
        ) {
          if (
            text.length >
            longestText.length
          ) {
            longestText = text;
            receivedText = true;
          }
        }
      }
    }

    /*
     * Gemini can theoretically leave the final line without a newline.
     * Parse it before returning.
     */
    if (buffer) {
      for (
        const text of
          extractTextsFromLine(buffer)
      ) {
        if (
          text.length >
          longestText.length
        ) {
          longestText = text;
        }
      }
    }

    return cleanText(
      longestText,
    );
  } finally {
    /*
     * If Gemini kept the upstream response open,
     * explicitly cancel it so the Worker can finish
     * the client response.
     */
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors.
    }

    try {
      reader.releaseLock();
    } catch {
      // Ignore release errors.
    }
  }
}

/**
 * Non-streaming generation with retry.
 *
 * Previously this waited indefinitely for Gemini's HTTP response
 * to close. Gemini Web can sometimes leave StreamGenerate open
 * even after the final useful text has already arrived.
 *
 * We now stop after STREAM_IDLE_TIMEOUT_MS of inactivity once
 * useful text has been received.
 */
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

  if (!resp.ok) {
    throw new Error(
      `Gemini upstream HTTP ${resp.status}`,
    );
  }

  return readResponseWithIdleTimeout(
    resp,
    STREAM_IDLE_TIMEOUT_MS,
  );
}

/**
 * Streaming generation.
 *
 * Yields incremental text deltas as they arrive.
 *
 * The important change here is that we do not wait forever for
 * Gemini's HTTP connection to close. Once useful text has been
 * received, an idle period of STREAM_IDLE_TIMEOUT_MS causes the
 * generator to finish.
 *
 * index.ts can then emit:
 *
 * finish_reason: "stop"
 * data: [DONE]
 */
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

  if (!resp.ok) {
    throw new Error(
      `Gemini upstream HTTP ${resp.status}`,
    );
  }

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
    .pipeThrough(new TextDecoderStream())
    .getReader();

  let buffer = "";
  let previousText = "";
  let receivedText = false;

  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;

      /*
       * IMPORTANT:
       * Only one reader.read() is active at any time.
       */
      const readPromise =
        reader.read();

      const timeoutPromise =
        new Promise<{
          timeout: true;
        }>((resolve) => {
          timer = setTimeout(
            () => {
              resolve({
                timeout: true,
              });
            },
            STREAM_IDLE_TIMEOUT_MS,
          );
        });

      const result =
        await Promise.race([
          readPromise.then(
            (value) => ({
              timeout: false as const,
              value,
            }),
          ),
          timeoutPromise,
        ]);

      if (timer !== undefined) {
        clearTimeout(timer);
      }

      /*
       * Gemini already gave us useful text and then stopped
       * sending data. Treat this as the end of the response.
       */
      if (result.timeout) {
        if (receivedText) {
          break;
        }

        /*
         * No text yet. Keep waiting rather than prematurely
         * terminating a slow first response.
         */
        continue;
      }

      const {
        done,
        value,
      } = result.value;

      if (done) {
        break;
      }

      buffer += value;

      let newlineIndex: number;

      while (
        (newlineIndex =
          buffer.indexOf("\n")) !== -1
      ) {
        const line =
          buffer.slice(
            0,
            newlineIndex,
          );

        buffer =
          buffer.slice(
            newlineIndex + 1,
          );

        const texts =
          extractTextsFromLine(
            line,
          );

        for (
          const text of texts
        ) {
          if (
            text.length <=
            previousText.length
          ) {
            continue;
          }

          const delta =
            cleanText(
              text.slice(
                previousText.length,
              ),
            );

          previousText = text;
          receivedText = true;

          if (delta) {
            yield delta;
          }
        }
      }
    }

    /*
     * Process any final incomplete line.
     */
    if (buffer) {
      const texts =
        extractTextsFromLine(
          buffer,
        );

      for (
        const text of texts
      ) {
        if (
          text.length <=
          previousText.length
        ) {
          continue;
        }

        const delta =
          cleanText(
            text.slice(
              previousText.length,
            ),
          );

        previousText = text;

        if (delta) {
          yield delta;
        }
      }
    }
  } finally {
    /*
     * Gemini may keep the HTTP connection alive after the answer.
     * Cancel it so the generator can actually finish and allow
     * index.ts to emit the OpenAI-compatible final SSE event.
     */
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors.
    }

    try {
      reader.releaseLock();
    } catch {
      // Ignore release errors.
    }
  }
}
