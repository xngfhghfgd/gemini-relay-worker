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

/*
 * Gemini Web occasionally keeps the HTTP connection alive after
 * the final useful response has already arrived.
 *
 * Once we have received text, if no additional bytes arrive within
 * this period, we abort the upstream request and finish normally.
 */
const STREAM_IDLE_TIMEOUT_MS = 8000;

export function accountPrefix(env: Env): string {
  const u = env.AUTH_USER;

  if (
    u === undefined ||
    u === null ||
    u === ""
  ) {
    return "";
  }

  return `/u/${u}`;
}

function parseSapisid(
  cookie: string,
): string | null {
  for (
    const pair of cookie.split("; ")
  ) {
    const eq = pair.indexOf("=");

    if (eq === -1) {
      continue;
    }

    if (
      pair.slice(0, eq) ===
      "SAPISID"
    ) {
      return pair.slice(eq + 1);
    }
  }

  return null;
}

export async function makeSapisidHash(
  sapisid: string,
): Promise<string> {
  const ts =
    Math.floor(Date.now() / 1000);

  const data =
    new TextEncoder().encode(
      `${ts} ${sapisid} https://gemini.google.com`,
    );

  const digest =
    await crypto.subtle.digest(
      "SHA-1",
      data,
    );

  const hex = [
    ...new Uint8Array(digest),
  ]
    .map((b) =>
      b.toString(16).padStart(2, "0"),
    )
    .join("");

  return `SAPISIDHASH ${ts}_${hex}`;
}

async function buildHeaders(
  env: Env,
): Promise<Record<string, string>> {
  const prefix =
    accountPrefix(env);

  const headers: Record<
    string,
    string
  > = {
    "Content-Type":
      "application/x-www-form-urlencoded",

    Origin:
      "https://gemini.google.com",

    Referer:
      `https://gemini.google.com${prefix}/app`,

    "X-Same-Domain": "1",

    "User-Agent":
      USER_AGENT,
  };

  if (prefix) {
    headers["X-Goog-AuthUser"] =
      String(env.AUTH_USER);
  }

  const cookie =
    env.COOKIE;

  if (cookie) {
    headers["Cookie"] =
      cookie;

    const sapisid =
      env.SAPISID ||
      parseSapisid(cookie);

    if (sapisid) {
      headers["Authorization"] =
        await makeSapisidHash(
          sapisid,
        );
    }
  }

  return headers;
}

function buildPayload(
  prompt: string,
  modeId: number,
  thinkMode: number,
  fileRefs: string[] | null,
  extra:
    | Record<number, unknown>
    | undefined,
  xsrfToken:
    | string
    | undefined,
): string {
  // Sparse positional array — indices carry meaning
  // (see models.ts / README).
  const inner: unknown[] =
    new Array(102).fill(null);

  if (
    fileRefs &&
    fileRefs.length
  ) {
    const refs =
      fileRefs.map((ref) => [
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
  inner[17] = [[
    thinkMode,
  ]];

  inner[18] = 0;
  inner[27] = 1;
  inner[30] = [4];
  inner[41] = [2];
  inner[53] = 0;
  inner[59] =
    crypto.randomUUID();
  inner[61] = [];
  inner[68] = 1;

  // MODE_CATEGORY model selector
  inner[79] = modeId;

  if (extra) {
    for (
      const [k, v]
      of Object.entries(extra)
    ) {
      inner[Number(k)] = v;
    }
  }

  const outer = [
    null,
    JSON.stringify(inner),
  ];

  const params =
    new URLSearchParams();

  params.set(
    "f.req",
    JSON.stringify(outer),
  );

  if (xsrfToken) {
    params.set(
      "at",
      xsrfToken,
    );
  }

  return params.toString();
}

function getUrl(
  env: Env,
): string {
  const reqid =
    Math.floor(
      Date.now() / 1000,
    ) % 1000000;

  const prefix =
    accountPrefix(env);

  return (
    `https://gemini.google.com${prefix}/_/BardChatUi/data/` +
    "assistant.lamda.BardFrontendService/StreamGenerate" +
    `?bl=${env.GEMINI_BL}&hl=en&_reqid=${reqid}&rt=c`
  );
}

function cleanText(
  text: string,
): string {
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
    !line.includes(
      '"wrb.fr"',
    ) ||
    line.length < 200
  ) {
    return [];
  }

  try {
    const arr =
      JSON.parse(line);

    const innerStr =
      arr?.[0]?.[2];

    if (
      !innerStr ||
      typeof innerStr !==
        "string" ||
      innerStr.length < 50
    ) {
      return [];
    }

    const inner =
      JSON.parse(innerStr);

    if (
      !(
        Array.isArray(inner) &&
        inner.length > 4 &&
        inner[4]
      )
    ) {
      return [];
    }

    const texts: string[] =
      [];

    for (
      const part of inner[4]
    ) {
      if (
        Array.isArray(part) &&
        part.length > 1 &&
        Array.isArray(part[1])
      ) {
        for (
          const t of part[1]
        ) {
          if (
            typeof t ===
              "string" &&
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

  for (
    const line of raw.split(
      "\n",
    )
  ) {
    for (
      const t of
        extractTextsFromLine(
          line,
        )
    ) {
      if (
        t.length >
        last.length
      ) {
        last = t;
      }
    }
  }

  return cleanText(last);
}

const sleep = (
  ms: number,
) =>
  new Promise<void>(
    (resolve) =>
      setTimeout(
        resolve,
        ms,
      ),
  );

/*
 * IMPORTANT:
 *
 * The original implementation returned only Response.
 *
 * We return the AbortController together with the Response so that
 * generate()/generateStream() can actively terminate Gemini's
 * upstream HTTP connection after the final useful content has
 * arrived.
 */
interface GeminiResponse {
  response: Response;
  controller: AbortController;
}

async function postGemini(
  prompt: string,
  modeId: number,
  thinkMode: number,
  fileRefs: string[] | null,
  extra:
    | Record<number, unknown>
    | undefined,
  env: Env,
): Promise<GeminiResponse> {
  const body =
    buildPayload(
      prompt,
      modeId,
      thinkMode,
      fileRefs,
      extra,
      env.XSRF_TOKEN,
    );

  const url =
    getUrl(env);

  const headers =
    await buildHeaders(env);

  const timeoutMs =
    (Number(
      env.REQUEST_TIMEOUT_SEC,
    ) || 180) * 1000;

  let lastErr: unknown;

  for (
    let attempt = 0;
    attempt <
    RETRY_ATTEMPTS;
    attempt++
  ) {
    const controller =
      new AbortController();

    const timeout =
      setTimeout(
        () => {
          controller.abort();
        },
        timeoutMs,
      );

    try {
      const response =
        await fetch(url, {
          method: "POST",
          headers,
          body,
          signal:
            controller.signal,
        });

      clearTimeout(
        timeout,
      );

      return {
        response,
        controller,
      };
    } catch (e) {
      clearTimeout(
        timeout,
      );

      lastErr = e;

      try {
        controller.abort();
      } catch {
        // Ignore.
      }

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
 * Non-streaming generation.
 *
 * The important difference from the original implementation is that
 * we read the response ourselves instead of using resp.text().
 *
 * Once useful Gemini text has arrived, an 8-second upstream idle
 * period causes the AbortController to terminate the still-open
 * Gemini connection.
 */
export async function generate(
  prompt: string,
  modeId: number,
  thinkMode: number,
  fileRefs: string[] | null,
  extra:
    | Record<number, unknown>
    | undefined,
  env: Env,
): Promise<string> {
  const {
    response,
    controller,
  } =
    await postGemini(
      prompt,
      modeId,
      thinkMode,
      fileRefs,
      extra,
      env,
    );

  if (!response.ok) {
    controller.abort();

    throw new Error(
      `Gemini upstream HTTP ${response.status}`,
    );
  }

  if (!response.body) {
    try {
      return extractResponseText(
        await response.text(),
      );
    } finally {
      controller.abort();
    }
  }

  const reader =
    response.body
      .pipeThrough(
        new TextDecoderStream(),
      )
      .getReader();

  let buf = "";
  let prevText = "";
  let receivedText = false;

  try {
    for (;;) {
      /*
       * Before the first useful text arrives, rely on the main
       * fetch timeout. We do NOT use the short idle timeout here,
       * because Gemini may legitimately take a while before its
       * first token.
       */
      if (!receivedText) {
        const {
          done,
          value,
        } =
          await reader.read();

        if (done) {
          break;
        }

        buf += value;
      } else {
        /*
         * After useful text exists, an idle timeout is meaningful.
         */
        let timer:
          | ReturnType<
              typeof setTimeout
            >
          | undefined;

        const readPromise =
          reader.read();

        const timeoutPromise =
          new Promise<{
            timeout: true;
          }>(
            (resolve) => {
              timer =
                setTimeout(
                  () =>
                    resolve(
                      {
                        timeout:
                          true,
                      },
                    ),
                  STREAM_IDLE_TIMEOUT_MS,
                );
            },
          );

        const result =
          await Promise.race([
            readPromise.then(
              (value) => ({
                timeout:
                  false as const,
                value,
              }),
            ),
            timeoutPromise,
          ]);

        if (
          timer !==
          undefined
        ) {
          clearTimeout(
            timer,
          );
        }

        if (
          result.timeout
        ) {
          /*
           * This is the critical fix:
           * actively kill Gemini's still-open
           * HTTP connection.
           */
          controller.abort();
          break;
        }

        const {
          done,
          value,
        } = result.value;

        if (done) {
          break;
        }

        buf += value;
      }

      let nl: number;

      while (
        (nl =
          buf.indexOf(
            "\n",
          )) !== -1
      ) {
        const line =
          buf.slice(
            0,
            nl,
          );

        buf =
          buf.slice(
            nl + 1,
          );

        for (
          const t of
            extractTextsFromLine(
              line,
            )
        ) {
          if (
            t.length >
            prevText.length
          ) {
            prevText = t;
            receivedText = true;
          }
        }
      }
    }

    /*
     * Process the final incomplete line.
     */
    if (buf) {
      for (
        const t of
          extractTextsFromLine(
            buf,
          )
      ) {
        if (
          t.length >
          prevText.length
        ) {
          prevText = t;
        }
      }
    }

    return cleanText(
      prevText,
    );
  } finally {
    try {
      controller.abort();
    } catch {
      // Ignore.
    }

    try {
      await reader.cancel();
    } catch {
      // Ignore.
    }

    try {
      reader.releaseLock();
    } catch {
      // Ignore.
    }
  }
}

/**
 * Streaming generation.
 *
 * Once Gemini has produced useful text, if the upstream connection
 * becomes idle for STREAM_IDLE_TIMEOUT_MS, we actively abort it.
 *
 * This lets the async generator actually finish, which allows
 * index.ts to send:
 *
 *   finish_reason: "stop"
 *   data: [DONE]
 */
export async function* generateStream(
  prompt: string,
  modeId: number,
  thinkMode: number,
  fileRefs: string[] | null,
  extra:
    | Record<number, unknown>
    | undefined,
  env: Env,
): AsyncGenerator<string> {
  const {
    response,
    controller,
  } =
    await postGemini(
      prompt,
      modeId,
      thinkMode,
      fileRefs,
      extra,
      env,
    );

  if (!response.ok) {
    controller.abort();

    throw new Error(
      `Gemini upstream HTTP ${response.status}`,
    );
  }

  if (!response.body) {
    try {
      const text =
        extractResponseText(
          await response.text(),
        );

      if (text) {
        yield text;
      }

      return;
    } finally {
      controller.abort();
    }
  }

  const reader =
    response.body
      .pipeThrough(
        new TextDecoderStream(),
      )
      .getReader();

  let buf = "";
  let prevText = "";
  let receivedText = false;

  try {
    for (;;) {
      /*
       * First chunk:
       *
       * Do not use the short idle timeout before Gemini has sent
       * anything. The normal fetch timeout handles this case.
       */
      if (!receivedText) {
        const {
          done,
          value,
        } =
          await reader.read();

        if (done) {
          break;
        }

        buf += value;
      } else {
        /*
         * After text has been received, wait only a limited amount
         * of time for more upstream data.
         */
        let timer:
          | ReturnType<
              typeof setTimeout
            >
          | undefined;

        const readPromise =
          reader.read();

        const timeoutPromise =
          new Promise<{
            timeout: true;
          }>(
            (resolve) => {
              timer =
                setTimeout(
                  () =>
                    resolve(
                      {
                        timeout:
                          true,
                      },
                    ),
                  STREAM_IDLE_TIMEOUT_MS,
                );
            },
          );

        const result =
          await Promise.race([
            readPromise.then(
              (value) => ({
                timeout:
                  false as const,
                value,
              }),
            ),
            timeoutPromise,
          ]);

        if (
          timer !==
          undefined
        ) {
          clearTimeout(
            timer,
          );
        }

        if (
          result.timeout
        ) {
          /*
           * Critical fix:
           * terminate Gemini's HTTP request.
           */
          controller.abort();
          break;
        }

        const {
          done,
          value,
        } = result.value;

        if (done) {
          break;
        }

        buf += value;
      }

      let nl: number;

      while (
        (nl =
          buf.indexOf(
            "\n",
          )) !== -1
      ) {
        const line =
          buf.slice(
            0,
            nl,
          );

        buf =
          buf.slice(
            nl + 1,
          );

        for (
          const t of
            extractTextsFromLine(
              line,
            )
        ) {
          if (
            t.length <=
            prevText.length
          ) {
            continue;
          }

          const delta =
            cleanText(
              t.slice(
                prevText.length,
              ),
            );

          prevText = t;
          receivedText = true;

          if (delta) {
            yield delta;
          }
        }
      }
    }

    /*
     * Gemini may leave the final wrb.fr payload without a trailing
     * newline. Parse whatever remains.
     */
    if (buf) {
      for (
        const t of
          extractTextsFromLine(
            buf,
          )
      ) {
        if (
          t.length <=
          prevText.length
        ) {
          continue;
        }

        const delta =
          cleanText(
            t.slice(
              prevText.length,
            ),
          );

        prevText = t;

        if (delta) {
          yield delta;
        }
      }
    }
  } finally {
    /*
     * Ensure the upstream Gemini connection is not left alive.
     */
    try {
      controller.abort();
    } catch {
      // Ignore.
    }

    try {
      await reader.cancel();
    } catch {
      // Ignore.
    }

    try {
      reader.releaseLock();
    } catch {
      // Ignore.
    }
  }
}
