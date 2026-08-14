/**
 * Client-side CSV parser for bulk Host × Service create (Asset page).
 * Mirrors platform parse_host_service_import_lines shape.
 *
 * Columns (header optional): address, port, protocol, name, tags
 * Port may be "80" or "80/tcp". Same host on multiple lines merges services.
 */

export type BulkService = {
  port: string;
  protocol?: string;
  name?: string;
};

export type BulkHostGroup = {
  address: string;
  tags: string[];
  services: BulkService[];
};

export type BulkParseResult = {
  groups: BulkHostGroup[];
  errors: string[];
  lineCount: number;
};

const KNOWN_PROTO = new Set([
  "tcp",
  "udp",
  "sctp",
  "http",
  "https",
  "tls",
  "ssl",
  "ssh",
  "ftp",
  "smtp",
  "dns",
  "rdp",
  "smb",
  "mysql",
  "postgres",
  "redis",
  "mongodb",
]);

const HEADER_ALIASES: Record<string, string[]> = {
  address: ["address", "ip", "host", "hostname", "url", "地址", "主机"],
  port: ["port", "ports", "端口"],
  protocol: ["protocol", "proto", "协议"],
  name: ["name", "service", "svc", "服务", "服务名"],
  tags: ["tags", "tag", "标签"],
};

function normalizePort(value: string): string | null {
  const text = String(value || "").trim().split("/", 1)[0]?.trim() || "";
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (n < 1 || n > 65535) return null;
  return String(n);
}

function splitPortProto(cell: string): { port: string | null; protocol: string } {
  const text = String(cell || "").trim();
  if (!text) return { port: null, protocol: "" };
  if (text.includes("/")) {
    const [left, right] = text.split("/", 2);
    return { port: normalizePort(left || ""), protocol: (right || "").trim().toLowerCase() };
  }
  return { port: normalizePort(text), protocol: "" };
}

/** Very light host check (IP or domain); full validation is server-side. */
function looksLikeHost(value: string): boolean {
  const t = String(value || "").trim();
  if (!t || t.includes(" ")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) return true;
  if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(t) && t.includes(".")) return true;
  if (/^[a-z0-9-]+$/i.test(t)) return true; // short host labels
  return false;
}

function splitHostPort(raw: string): { host: string; port: string | null } {
  const t = String(raw || "").trim();
  // [ipv6]:port not required for v1
  const m = t.match(/^([^:\s]+):(\d{1,5})$/);
  if (m) return { host: m[1] || "", port: normalizePort(m[2] || "") };
  return { host: t, port: null };
}

function splitTags(raw: string): string[] {
  return String(raw || "")
    .split(/[,|，、]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function splitCells(line: string): string[] {
  const parts = line.split(/[,;\t]/).map((p) => p.trim().replace(/^["']|["']$/g, ""));
  while (parts.length && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Parse bulk CSV / paste text into host groups ready for POST /api/assets.
 */
export function parseBulkHostCsv(text: string): BulkParseResult {
  const errors: string[] = [];
  const lines = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let headerMap: Record<string, number> | null = null;
  const byHost = new Map<string, BulkHostGroup>();
  const order: string[] = [];
  let dataLines = 0;

  const cell = (parts: string[], key: string, fallbackIdx: number | null): string => {
    if (headerMap && key in headerMap) {
      const i = headerMap[key]!;
      return parts[i] ?? "";
    }
    if (fallbackIdx != null && fallbackIdx < parts.length) return parts[fallbackIdx] ?? "";
    return "";
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = splitCells(line);
    if (!parts.length) continue;

    const lower0 = parts[0]!.toLowerCase();
    if (!headerMap) {
      const joined = new Set(parts.map((p) => p.toLowerCase()));
      const looksHeader =
        HEADER_ALIASES.address!.includes(lower0) ||
        joined.has("address") ||
        joined.has("ip") ||
        joined.has("地址");
      if (looksHeader) {
        headerMap = {};
        parts.forEach((p, i) => {
          const c = p.toLowerCase();
          for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
            if (aliases.includes(c) && !(key in headerMap!)) {
              headerMap![key] = i;
            }
          }
        });
        if ("address" in headerMap) continue;
        headerMap = null;
      }
    }

    dataLines += 1;
    const addrRaw = cell(parts, "address", 0);
    const portRaw = cell(parts, "port", headerMap ? null : 1);
    const protoRaw = cell(parts, "protocol", headerMap ? null : 2).toLowerCase();
    const nameRaw = cell(parts, "name", headerMap ? null : 3);
    const tagsRaw = cell(parts, "tags", headerMap ? null : 4);

    const { host: hostFromAddr, port: portFromAddr } = splitHostPort(addrRaw);
    if (!hostFromAddr || !looksLikeHost(hostFromAddr)) {
      errors.push(`第 ${li + 1} 行：无效地址「${addrRaw || "（空）"}」`);
      continue;
    }
    const host = hostFromAddr.toLowerCase();

    let { port: portN, protocol: protoFromPort } = splitPortProto(portRaw);
    if (!portN && portFromAddr) portN = portFromAddr;
    // Prefer protocol embedded in port (80/tcp). If port already has /proto,
    // the next bare cell is service name (e.g. 22/tcp,ssh → name=ssh).
    let protocol = (protoFromPort || "").trim().toLowerCase();
    let svcName = nameRaw.trim();
    if (protoRaw) {
      if (protoFromPort) {
        if (!svcName) svcName = protoRaw;
      } else if (KNOWN_PROTO.has(protoRaw)) {
        protocol = protoRaw;
      } else if (!svcName) {
        svcName = protoRaw;
      }
    }
    const tags = splitTags(tagsRaw);

    if (!byHost.has(host)) {
      byHost.set(host, { address: host, tags: [], services: [] });
      order.push(host);
    }
    const entry = byHost.get(host)!;
    if (tags.length) {
      const seen = new Set(entry.tags.map((t) => t.toLowerCase()));
      for (const t of tags) {
        if (!seen.has(t.toLowerCase())) {
          entry.tags.push(t);
          seen.add(t.toLowerCase());
        }
      }
    }
    if (portN) {
      const existing = entry.services.find((s) => s.port === portN);
      if (existing) {
        if (protocol) existing.protocol = protocol;
        if (svcName) existing.name = svcName;
      } else {
        const svc: BulkService = { port: portN };
        if (protocol) svc.protocol = protocol;
        if (svcName) svc.name = svcName;
        entry.services.push(svc);
      }
    }
  }

  return {
    groups: order.map((h) => byHost.get(h)!),
    errors,
    lineCount: dataLines,
  };
}

/** One-line summary for UI preview. */
export function summarizeBulkGroups(groups: BulkHostGroup[]): string {
  const hosts = groups.length;
  const ports = groups.reduce((n, g) => n + g.services.length, 0);
  if (!hosts) return "未解析到主机";
  return `${hosts} 台主机` + (ports ? ` · ${ports} 个端口` : "（无端口）");
}
