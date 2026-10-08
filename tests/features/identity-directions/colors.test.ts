import { describe,expect,it } from "vitest";
import { describeColor } from "@/features/identity-directions/model/colors";
describe("truthful color specifications",()=>{
 it("keeps exact RGB and HEX with print matches unavailable",()=>{expect(describeColor("#f20a8c",{icc:null,pantone:null})).toEqual({hex:"#F20A8C",rgb:[242,10,140],cmyk:{status:"unavailable",reason:"profile_unavailable"},pantone:{status:"unavailable",reason:"licensed_source_unavailable"}});});
 it("requires receipts to bind the exact color, ICC hash and rights source",()=>{expect(()=>describeColor("#FFFFFF",{icc:{sourceHex:"#000000",channels:[0,0,0,100],profileId:"coated",profileHash:"a".repeat(64),conversionVersion:"v1",limitations:["Paper dependent"]},pantone:null})).toThrow();expect(()=>describeColor("#FFFFFF",{icc:null,pantone:{sourceHex:"#FFFFFF",reference:"Example",sourceId:"reviewed",sourceHash:"b".repeat(64),rightsEvidenceId:"",limitations:["Approximate"]}})).toThrow();});
});
