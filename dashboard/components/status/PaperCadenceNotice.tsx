import { paperCadenceNotice } from "@/lib/status/cadence";
import type { StrategyStatusPayload } from "@/lib/status/types";
import { UnavailableBlock } from "./primitives";

export default function PaperCadenceNotice({ payload }: { payload: StrategyStatusPayload }) {
  const notice = paperCadenceNotice(payload);
  return notice ? <div className="mb-4"><UnavailableBlock state={notice.pending ? "PENDING" : "WARN"}
    title={notice.pending ? "Paper cycle in progress" : "Today's paper cycle is not confirmed"}
    detail={notice.detail} /></div> : null;
}
