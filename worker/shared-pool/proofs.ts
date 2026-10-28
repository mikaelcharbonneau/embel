/** Reviewed source release pins, not values learned from the connected server.
 * Changing a procedure requires a reviewed source/native validation update. */
import authorityManifest from "./authority-manifest.json";
export type SharedRpcProof=Readonly<{sha256:string;language:"plpgsql"|"sql";volatility:"v"|"s"}>;
export const SHARED_CORE_RPC_PROOFS=Object.freeze({
 claim:{sha256:"2d0b72dd3a119feaac2ab15fcdcccf13eb00b4855bbd12ec26b72de06b84c9ef",language:"plpgsql",volatility:"v"},
 renew:{sha256:"7ffa4254d814e35ab42689f58698cf3621b0c0a60220edccd1498d0d5999e649",language:"plpgsql",volatility:"v"},
 release:{sha256:"b98de8d3e181e14e3281966ded0df84c9bbb3feddd8e8b3b35e1f2c59964e1fc",language:"plpgsql",volatility:"v"},
 fence:{sha256:"0f169fcaeff11f1d1075a56b3fd25cd667812b53abc4f112543caf1426925ae2",language:"plpgsql",volatility:"v"},
 pending:{sha256:"ae88161f5f514f2ab1a40782c91e8cbf2e717ef9295acddc08a6a516fd6de834",language:"plpgsql",volatility:"v"},
 capacity:{sha256:"328c03f02d52229a0929c92c1e4bf9048925cad3be794e97bb48cc06b98f6c70",language:"plpgsql",volatility:"s"},
} satisfies Readonly<Record<string,SharedRpcProof>>);
export function equalSharedRpcProof(actual:SharedRpcProof,expected:SharedRpcProof){return actual.sha256===expected.sha256&&actual.language===expected.language&&actual.volatility===expected.volatility;}
function nativeProof(name:string):SharedRpcProof{
 const fn=authorityManifest.functions.find(value=>value.schema==="public"&&value.name===name);
 if(!fn||!["sql","plpgsql"].includes(fn.language)||!["s","v"].includes(fn.volatility)||fn.owner!=="postgres"||!fn.securityDefiner||fn.leakproof)throw Error("shared_release_manifest_invalid");
 return{sha256:fn.sha256,language:fn.language as SharedRpcProof["language"],volatility:fn.volatility as SharedRpcProof["volatility"]};
}
export const SHARED_LANE_RPC_PROOFS=Object.freeze({strategy:nativeProof("shared_strategy_worker_action"),naming:nativeProof("shared_naming_worker_action"),logo:nativeProof("shared_logo_worker_action")});
export const SHARED_STRATEGY_OUTBOX_PROOF=Object.freeze(nativeProof("list_shared_strategy_dispatches"));
