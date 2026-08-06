/**
 * Spec #299: three-state pack honesty + expert schedulability helpers.
 * Run: npx tsx src/lib/packHonesty.test.ts
 */
import {
  isExpertSchedulable,
  packHonestyLabel,
  packHonestyState,
} from "./experts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// Offline offer → queued, never bare "synced / 已安装"
{
  const s = packHonestyState({ offered: true, nodeOnline: false });
  assert(s === "queued", "offline offer is queued");
  assert(packHonestyLabel(s) === "待同步", "queued label");
}

// Offline install response with deferred delivery
{
  const s = packHonestyState({
    offered: true,
    nodeOnline: false,
    lastDelivery: {
      node_delivery: { delivered: false, reason: "offline" },
      note: "Offer saved; pack files will install when the node is online",
    },
  });
  assert(s === "queued", "deferred offline delivery is queued");
  assert(packHonestyLabel(s) !== "已同步", "not runnable synced");
  assert(packHonestyLabel(s) !== "已安装", "not bare installed");
}

// Online successful delivery → synced
{
  const s = packHonestyState({
    offered: true,
    nodeOnline: true,
    lastDelivery: { node_delivery: { delivered: true } },
  });
  assert(s === "synced", "online delivered is synced");
  assert(packHonestyLabel(s) === "已同步", "synced label");
}

// Online with no last delivery snapshot still presents as synced for list chips
{
  const s = packHonestyState({ offered: true, nodeOnline: true });
  assert(s === "synced", "online offer without snapshot is synced presentation");
}

// Online push failure (non-offline reason) → failed
{
  const s = packHonestyState({
    offered: true,
    nodeOnline: true,
    lastDelivery: {
      node_delivery: { delivered: false, reason: "ws send failed" },
      note: "could not push",
    },
  });
  assert(s === "failed", "online undelivered non-offline is failed");
  assert(packHonestyLabel(s) === "失败", "failed label");
}

// Not in offers
{
  assert(
    packHonestyState({ offered: false, nodeOnline: true }) === "not_offered",
    "not offered",
  );
  assert(packHonestyLabel("not_offered") === "未安装", "not installed label");
}

// Schedulability
assert(isExpertSchedulable("online") === true, "online schedulable");
assert(isExpertSchedulable("ONLINE") === true, "online casefold");
assert(isExpertSchedulable("offline") === false, "offline not schedulable");
assert(isExpertSchedulable(null) === false, "null not schedulable");
assert(isExpertSchedulable(undefined) === false, "undefined not schedulable");
assert(isExpertSchedulable("") === false, "empty not schedulable");

console.log("packHonesty.test.ts: ok");
