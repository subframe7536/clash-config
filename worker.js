const CONFIG_URL =
  "https://github.com/subframe7536/clash-config/raw/refs/heads/main/config.yaml";

const EMPTY_SUB_URL =
  "https://ryanvanson.github.io/emptyyaml/empty.yaml";

const CONFIG_CACHE_TTL = 300;
const GITHUB_CACHE_TTL = 3600;

const encoder = new TextEncoder();

async function timingSafeEqual(a, b) {
  const [aa, bb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);

  return crypto.subtle.timingSafeEqual(aa, bb);
}

function notFound() {
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function yamlString(value) {
  return JSON.stringify(value);
}

function getEnvString(env, key, fallback) {
  const value = env[key];

  return typeof value === "string" && value.length > 0
    ? value
    : fallback;
}

function collectSubscriptions(env) {
  const indexes = new Set();

  for (const key of Object.keys(env)) {
    const match = /^SUB_([1-9]\d*)_(?:URL|NAME)$/.exec(key);

    if (match) {
      indexes.add(Number(match[1]));
    }
  }

  return [...indexes]
    .sort((a, b) => a - b)
    .map((index) => ({
      id: `SUB_${index}`,
      url: getEnvString(
        env,
        `SUB_${index}_URL`,
        EMPTY_SUB_URL,
      ),
      name: getEnvString(
        env,
        `SUB_${index}_NAME`,
        `empty-${index}`,
      ),
    }));
}

function renderProviders(subscriptions) {
  return subscriptions
    .map(({ id, url, name }) =>
      [
        `  ${id}:`,
        "    type: http",
        `    url: ${yamlString(url)}`,
        `    path: ${yamlString(`./${name}.yaml`)}`,
        "    interval: 21600",
        "    health-check:",
        "      enable: false",
        '      url: "https://www.gstatic.com/generate_204"',
        "      interval: 300",
        "      lazy: true",
      ].join("\n"),
    )
    .join("\n");
}

function renderProviderNames(subscriptions) {
  return subscriptions
    .map(({ id }) => `      - ${id}`)
    .join("\n");
}

function replaceRequired(config, marker, replacement) {
  if (!config.includes(marker)) {
    throw new Error(`Missing template marker: ${marker}`);
  }

  return config.replaceAll(marker, replacement);
}

/**
 * Convert:
 *
 * https://raw.githubusercontent.com/owner/repo/ref/path
 *
 * and:
 *
 * https://github.com/owner/repo/raw/ref/path
 *
 * into:
 *
 * https://worker/<token>/gh/owner/repo/ref/path
 */
function toGitHubProxyUrl(value, proxyBaseUrl) {
  let source;

  try {
    source = new URL(value);
  } catch {
    return value;
  }

  let path;

  if (source.hostname === "raw.githubusercontent.com") {
    path = source.pathname.replace(/^\/+/, "");
  } else if (source.hostname === "github.com") {
    const match = source.pathname.match(
      /^\/([^/]+)\/([^/]+)\/raw\/(.+)$/,
    );

    if (!match) {
      return value;
    }

    path = `${match[1]}/${match[2]}/${match[3]}`;
  } else {
    return value;
  }

  if (!path) {
    return value;
  }

  return `${proxyBaseUrl}/${path}${source.search}`;
}

/**
 * Only rewrite URLs inside the top-level `rule-providers:` section.
 *
 * This prevents SUB_n_URL or other GitHub URLs elsewhere in the
 * configuration from being unintentionally rewritten.
 */
function rewriteRuleProviderUrls(config, proxyBaseUrl) {
  const lines = config.split("\n");

  let inRuleProviders = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^rule-providers:\s*(?:#.*)?$/.test(line)) {
      inRuleProviders = true;
      continue;
    }

    if (
      inRuleProviders &&
      /^[^\s#][^:]*:\s*/.test(line)
    ) {
      inRuleProviders = false;
    }

    if (!inRuleProviders) {
      continue;
    }

    lines[i] = line.replace(
      /https:\/\/(?:raw\.githubusercontent\.com|github\.com)\/[^\s"'<>]+/g,
      (value) => toGitHubProxyUrl(value, proxyBaseUrl),
    );
  }

  return lines.join("\n");
}

function renderConfig(template, env, url, token) {
  const subscriptions = collectSubscriptions(env);

  const workerBaseUrl =
    `${url.protocol}//${url.host}/${token}`;

  const defaultProviderUrl =
    `${workerBaseUrl}/provider`;

  const githubProxyBaseUrl =
    `${workerBaseUrl}/gh`;

  let config = template;

  config = replaceRequired(
    config,
    '"<SUB_DEFAULT_URL>"',
    yamlString(defaultProviderUrl),
  );

  config = replaceRequired(
    config,
    "  # <SUB_PROVIDERS>",
    renderProviders(subscriptions),
  );

  config = replaceRequired(
    config,
    "      # <SUB_PROVIDER_NAMES>",
    renderProviderNames(subscriptions),
  );

  config = rewriteRuleProviderUrls(
    config,
    githubProxyBaseUrl,
  );

  const unresolved = config.match(
    /<SUB_[A-Z0-9_]+>/g,
  );

  if (unresolved) {
    throw new Error(
      `Unresolved template markers: ${
        [...new Set(unresolved)].join(", ")
      }`,
    );
  }

  return config;
}

async function fetchConfigTemplate() {
  const response = await fetch(CONFIG_URL, {
    cf: {
      cacheEverything: true,
      cacheTtlByStatus: {
        "200-299": CONFIG_CACHE_TTL,
        "404": 30,
        "500-599": 0,
      },
    },
  });

  if (!response.ok) {
    throw new Error(
      `Config upstream returned ${response.status}`,
    );
  }

  return response.text();
}

async function handleConfig(url, token, env) {
  try {
    const template = await fetchConfigTemplate();

    const config = renderConfig(
      template,
      env,
      url,
      token,
    );

    return new Response(config, {
      headers: {
        "Content-Type": "text/yaml; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Failed to generate config",
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }),
    );

    return new Response(
      "Failed to generate config",
      {
        status: 502,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }
}

async function handleProvider(request, token, env) {
  const baseUrl =
    typeof env.SUBSCRIPTION_BASE_URL === "string"
      ? env.SUBSCRIPTION_BASE_URL.replace(/\/+$/, "")
      : "";

  if (!baseUrl) {
    console.error("Missing SUBSCRIPTION_BASE_URL");

    return new Response("Internal Server Error", {
      status: 500,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  try {
    const upstream = await fetch(
      `${baseUrl}/${encodeURIComponent(token)}/clmi.yaml`,
      {
        headers: {
          "User-Agent":
            request.headers.get("User-Agent") || "mihomo",
        },
      },
    );

    const response = new Response(
      upstream.body,
      upstream,
    );

    response.headers.set(
      "Cache-Control",
      "private, no-store",
    );

    response.headers.delete("set-cookie");

    return response;
  } catch (error) {
    console.error(
      JSON.stringify({
        message:
          "Failed to fetch subscription provider",
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }),
    );

    return new Response("Bad Gateway", {
      status: 502,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }
}

async function handleGitHubRaw(request, url, path) {
  // owner/repo/ref/file requires at least four path components.
  if (path.split("/").length < 4) {
    return notFound();
  }

  const upstreamUrl =
    new URL(`https://raw.githubusercontent.com/${path}`);

  upstreamUrl.search = url.search;

  const headers = new Headers();

  headers.set(
    "User-Agent",
    request.headers.get("User-Agent") || "mihomo",
  );

  const accept = request.headers.get("Accept");

  if (accept) {
    headers.set("Accept", accept);
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      headers,
      cf: {
        cacheEverything: true,
        cacheTtlByStatus: {
          "200-299": GITHUB_CACHE_TTL,
          "404": 60,
          "500-599": 0,
        },
      },
    });

    const response = new Response(
      upstream.body,
      upstream,
    );

    // Browser / mihomo-side caching.
    // Cloudflare subrequest caching is controlled separately above.
    response.headers.set(
      "Cache-Control",
      `public, max-age=${GITHUB_CACHE_TTL}`,
    );

    response.headers.delete("set-cookie");

    return response;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "Failed to fetch GitHub raw file",
        upstream: upstreamUrl.toString(),
        error:
          error instanceof Error
            ? error.message
            : String(error),
      }),
    );

    return new Response("Bad Gateway", {
      status: 502,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET",
          "Cache-Control": "no-store",
        },
      });
    }

    const url = new URL(request.url);

    const parts = url.pathname
      .split("/")
      .filter(Boolean);

    if (parts.length < 2) {
      return notFound();
    }

    const [token, endpoint, ...rest] = parts;

    if (
      typeof env.ACCESS_TOKEN !== "string" ||
      !(await timingSafeEqual(
        token,
        env.ACCESS_TOKEN,
      ))
    ) {
      return notFound();
    }

    if (
      endpoint === "config.yaml" &&
      rest.length === 0
    ) {
      return handleConfig(
        url,
        token,
        env,
      );
    }

    if (
      endpoint === "provider" &&
      rest.length === 0
    ) {
      return handleProvider(
        request,
        token,
        env,
      );
    }

    if (
      endpoint === "gh" &&
      rest.length > 0
    ) {
      return handleGitHubRaw(
        request,
        url,
        rest.join("/"),
      );
    }

    return notFound();
  },
};
