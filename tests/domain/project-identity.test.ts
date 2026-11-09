import { describe, expect, it } from "vitest";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { createIdentityReferenceSnapshot } from "../../src/domain/identity-references";
import {
  createIdentityInputSnapshot, getIdentityCurrentBasis, getIdentityFreshness, getIdentityReadiness,
  identityBasis, identityBasisKey, identityInputSnapshotSchema, identitySelectionWithSystemSchema,
  identitySystemDetailSchema, identitySystemPageSchema, identitySystemVersionSchema, initialIdentityPreferences,
  listIdentitySystemsSchema, projectIdentityOverviewSchema, refineIdentityComponent,
  refineIdentityComponentSchema, resolveIdentityName, selectIdentitySystem, selectIdentitySystemSchema,
  selectIdentitySystemResponseSchema, summarizeIdentitySystem, updateIdentityPreferencesResponseSchema,
  updateIdentityPreferencesSchema, validateIdentityRefinement,
} from "../../src/domain/project-identity";

const id=(n:number)=>`50000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const ownerId=id(1),projectId=id(2),systemId=id(3),at="2026-10-04T12:00:00.123456Z";
const context=()=>contextSnapshotSchema.parse({description:"A neighborhood design studio",activity:"Design",offering:"Brand systems",reformulationConfirmed:true,
  competitorReviewComplete:true,audienceSegments:[{id:id(10),label:"Independent businesses",needs:["Clarity"],reason:"Local clients",selected:true,origin:"user"}],
  personality:{sincerity:70,excitement:40,competence:80,sophistication:50,ruggedness:20},positioning:"Considered local design",selectedName:"Cedar",
  intake:{suppliedName:"Cedar",audienceReviewedAt:at,personalityReviewedAt:at,positioningReviewedAt:at}});
const media=(n=20,mimeType="image/png")=>({ownerId,projectId,assetId:id(n),versionId:id(n+1),contentHash:n.toString(16).padStart(64,"0"),purpose:"brand_asset",mimeType});
const references=()=>createIdentityReferenceSnapshot({ownerId,projectId,referenceRevision:1,selectedReferenceCount:1,capturedAt:at,selected:[{
  reference:{id:id(30),ownerId,projectId,createdAt:at,media:{...media(31),purpose:"reference_media",mimeType:"image/png"},source:"user_supplied",attribution:{label:"User reference",creator:null,sourceUrl:null,rightsNote:null},relevantElements:["colors","typography"],tags:[]},
  reaction:{referenceId:id(30),ownerId,projectId,revision:1,ensemble:false,elements:["colors"],updatedAt:at},
}]});
const snapshot=(saved=context(),projectRevision=1)=>createIdentityInputSnapshot({ownerId,projectId,scope:"complete_brand",projectRevision,context:saved,referenceSnapshot:references(),preferencesRevision:0,preferences:initialIdentityPreferences(saved),capturedAt:at});
const colors=()=>({swatches:[{key:"primary",name:"Forest",hex:"#123456"}],usageNotes:"Use with white space."});
const typography=()=>({styles:[{key:"body",role:"Body",family:"Example Family",weight:400,style:"normal"}],usageNotes:"Keep text readable."});
const direction=()=>({direction:"A restrained geometric language.",usageNotes:"Use consistently."});
const rawSystem=()=>({id:systemId,ownerId,projectId,createdAt:at,input:snapshot(),source:{kind:"generated",batchId:id(40),jobId:id(41),stepKey:"identity.board.1"},
  components:{logo:direction(),colors:colors(),typography:typography(),graphics:direction(),imagery:direction(),composition:direction()},
  board:{asset:media(),depictsSystemVersionId:systemId,staleComponents:[]},
  productionFiles:[{component:"logo",role:"Primary raster",asset:media(50)},{component:"colors",role:"Palette specification",asset:media(60,"application/json")}],
});
const system=()=>identitySystemVersionSchema.parse(rawSystem());
const selectRequest=()=>({systemVersionId:systemId,expectedProjectRevision:1,expectedReferenceRevision:1,expectedPreferencesRevision:0,expectedIdentityRevision:0,acceptEarlierBasis:false});
const selected=()=>selectIdentitySystem({actorId:ownerId,projectId,system:system(),currentInput:snapshot(),previousSelection:null,identityRevision:0,request:selectRequest(),selectionId:id(70),now:at});
const editRequest=()=>({baseSystemVersionId:systemId,component:"colors",expectedProjectRevision:1,expectedReferenceRevision:1,expectedPreferencesRevision:0,expectedIdentityRevision:1,acceptEarlierBasis:false,input:{...colors(),swatches:[{key:"primary",name:"Berry",hex:"#AA2255"}]},idempotencyKey:"manual-color-edit-1"});
const edit=()=>refineIdentityComponent({actorId:ownerId,projectId,base:system(),currentInput:snapshot(),previousSelection:selected(),identityRevision:1,request:editRequest(),systemVersionId:id(80),changeId:id(81),selectionId:id(82),now:at});

describe("Identity saved names, readiness and material inputs",()=>{
  it("uses an existing supplied name without requiring a Naming-generated candidate",()=>{
    const supplied=contextSnapshotSchema.parse({...context(),selectedName:null});
    expect(resolveIdentityName(supplied)).toEqual({status:"resolved",value:"Cedar",source:"supplied_name"});
    expect(getIdentityReadiness(supplied,"complete_brand",{selectedReferenceCount:1})).toMatchObject({ready:true,blocking:[],missingStrategy:[]});
    const inconsistent=contextSnapshotSchema.parse({...context(),selectedName:"Elm"});
    expect(resolveIdentityName(inconsistent).status).toBe("inconsistent");
    expect(getIdentityReadiness(inconsistent,"complete_brand",{selectedReferenceCount:1})).toMatchObject({ready:false,blocking:["inconsistent_name"]});
    expect(()=>snapshot(inconsistent)).toThrow();
    const canon=contextSnapshotSchema.parse({...context(),selectedName:" Café ",intake:{...context().intake,suppliedName:"Cafe\u0301"}});
    expect(resolveIdentityName(canon)).toMatchObject({status:"resolved",value:"Café"});
  });
  it("requires the reviewed strategy, a name and a reference before Identity is ready",()=>{
    const minimal=contextSnapshotSchema.parse({description:"Existing studio",intake:{suppliedName:"Cedar"}});
    const partial=getIdentityReadiness(minimal,"complete_brand",{selectedReferenceCount:1});
    expect(partial.ready).toBe(false);expect(partial.missingStrategy).toContain("audience");
    expect(getIdentityReadiness(context(),"complete_brand",{selectedReferenceCount:0}).blocking).toContain("references");
    const unreviewed=contextSnapshotSchema.parse({...context(),intake:{...context().intake,audienceReviewedAt:null}});
    expect(getIdentityReadiness(unreviewed,"complete_brand",{selectedReferenceCount:1}).blocking).toContain("audience");
  });
  it("ignores capture/review/revision/name-source metadata but tracks material inputs",()=>{
    const before=snapshot();
    const changedContext=contextSnapshotSchema.parse({...context(),selectedName:null,intake:{...context().intake,step:"positioning",audienceReviewedAt:"2026-10-04T13:00:00Z"}});
    const after=snapshot(changedContext,2);
    expect(identityBasisKey(before.basis)).toBe(identityBasisKey(after.basis));
    const differentScope=createIdentityInputSnapshot({...before,scope:"visual_identity_only"});
    expect(differentScope.scope).toBe("visual_identity_only");
    expect(identityBasisKey(differentScope.basis)).toBe(identityBasisKey(before.basis));
    const current={status:"available" as const,basis:after.basis};
    expect(getIdentityFreshness(before.basis,current)).toEqual({status:"current",changed:[]});
    const renamed=contextSnapshotSchema.parse({...context(),selectedName:"Elm",intake:{...context().intake,suppliedName:"Elm"}});
    expect(getIdentityFreshness(before.basis,{status:"available",basis:snapshot(renamed,2).basis})).toEqual({status:"stale",changed:["name"]});
    const refs=references();
    const referenceSnapshot=createIdentityReferenceSnapshot({...refs,referenceRevision:2,selected:[{...refs.selected[0]!,reaction:{...refs.selected[0]!.reaction,revision:2,elements:["typography"]}}]});
    const revised=identityBasis({ownerId,projectId,context:context(),references:referenceSnapshot,preferences:initialIdentityPreferences(context())});
    expect(getIdentityFreshness(before.basis,{status:"available",basis:revised})).toEqual({status:"stale",changed:["references"]});
    const noted=identityBasis({ownerId,projectId,context:context(),references:refs,preferences:{...initialIdentityPreferences(context()),avoidanceNotes:"Avoid metallic textures"}});
    expect(getIdentityFreshness(before.basis,{status:"available",basis:noted})).toMatchObject({changed:["preferences"]});
    const strategy=snapshot(contextSnapshotSchema.parse({...context(),description:"A different saved brief"}),2);
    expect(getIdentityFreshness(before.basis,{status:"available",basis:strategy.basis})).toMatchObject({changed:["strategy"]});
  });
  it("binds snapshots to exact owned material inputs and keeps all selected references",()=>{
    const value=snapshot();
    expect(Object.isFrozen(value.basis.referenceBasis.references)).toBe(true);
    expect(identityInputSnapshotSchema.safeParse({...value,basis:{...value.basis,name:"Forged"}}).success).toBe(false);
    expect(identityInputSnapshotSchema.safeParse({...value,projectId:id(99)}).success).toBe(false);
    expect(identityInputSnapshotSchema.safeParse({...value,preferences:{...value.preferences,notes:"Unsaved override"}}).success).toBe(false);
    expect(()=>getIdentityFreshness(value.basis,{status:"available",basis:{...value.basis,projectId:id(99)}})).toThrow();
    const empty=contextSnapshotSchema.parse({...context(),selectedName:null,intake:{...context().intake,suppliedName:""}});
    expect(getIdentityCurrentBasis({ownerId,projectId,context:empty,references:references(),preferences:initialIdentityPreferences(empty)})).toEqual({status:"unavailable",reason:"missing_name"});
    const template=references().selected[0]!;
    const full=createIdentityReferenceSnapshot({ownerId,projectId,referenceRevision:1,selectedReferenceCount:100,capturedAt:at,selected:Array.from({length:100},(_,index)=>({
      reference:{...template.reference,id:id(1000+index)},reaction:{...template.reaction,referenceId:id(1000+index)},
    }))});
    const complete=createIdentityInputSnapshot({...snapshot(),referenceSnapshot:full});
    expect(complete.referenceSnapshot.selected).toHaveLength(100);
    expect(complete.basis.referenceBasis.references).toHaveLength(100);
  });
});

describe("complete six-component systems and separate genuine-file evidence",()=>{
  it("requires all six components and an owned board, without inventing separate production files",()=>{
    const value=rawSystem();
    expect(identitySystemVersionSchema.safeParse({...value,productionFiles:[]}).success).toBe(true);
    expect(identitySystemVersionSchema.safeParse({...value,components:{logo:direction()}}).success).toBe(false);
    expect(identitySystemVersionSchema.safeParse({...value,board:null}).success).toBe(false);
    expect(identitySystemVersionSchema.safeParse({...value,components:{...value.components,colors:{swatches:[],usageNotes:""}}}).success).toBe(false);
    expect(identitySystemVersionSchema.safeParse({...value,components:{...value.components,typography:{styles:[],usageNotes:""}}}).success).toBe(false);
    expect(Object.isFrozen(system().components)).toBe(true);
  });
  it("rejects forged media scope, mutable heads and invented generation/vector/file claims",()=>{
    const value=rawSystem();
    for(const patch of [{ownerId:id(99)},{projectId:id(99)},{purpose:"reference_media"},{storagePath:"private/path"},{fileState:"verified"},{vectorStatus:"validated_paths"}]){
      expect(identitySystemVersionSchema.safeParse({...value,board:{...value.board,asset:{...value.board.asset,...patch}}}).success).toBe(false);
    }
    expect(identitySystemVersionSchema.safeParse({...value,source:{...value.source,provider:"forged"}}).success).toBe(false);
    expect(identitySystemVersionSchema.safeParse({...value,productionFiles:[{component:"logo",role:"Fake extracted logo",asset:value.board.asset}]}).success).toBe(false);
    const repeated={...value.productionFiles[0]!,component:"graphics",asset:{...value.productionFiles[0]!.asset,contentHash:"b".repeat(64)}};
    expect(identitySystemVersionSchema.safeParse({...value,productionFiles:[...value.productionFiles,repeated]}).success).toBe(false);
    expect(identitySystemVersionSchema.safeParse({...value,board:{...value.board,depictsSystemVersionId:id(99)}}).success).toBe(false);
  });
  it("does not relabel a byte-identical copy of the whole board as a production component file",()=>{
    const value=rawSystem();
    expect(identitySystemVersionSchema.safeParse({...value,productionFiles:[{component:"logo",role:"Copied board",asset:{...media(99),contentHash:value.board.asset.contentHash}}]}).success).toBe(false);
  });
});

describe("immutable selection and exact-base user edits",()=>{
  it("appends selection/restoration events and checks owned current revisions",()=>{
    const original=system(),first=selected();
    const second=selectIdentitySystem({actorId:ownerId,projectId,system:original,currentInput:snapshot(),previousSelection:first,identityRevision:1,request:{...selectRequest(),expectedIdentityRevision:1},selectionId:id(71),now:at,reason:"restored"});
    expect(second).toMatchObject({identityRevision:2,previousSelectionId:first.id,reason:"restored",systemVersionId:original.id});
    expect(first.identityRevision).toBe(1);expect(original).toEqual(system());
    for(const args of [{actorId:id(99)},{projectId:id(99)},{identityRevision:2},{request:{...selectRequest(),expectedProjectRevision:2}}]){
      expect(()=>selectIdentitySystem({actorId:ownerId,projectId,system:original,currentInput:snapshot(),previousSelection:null,identityRevision:0,request:selectRequest(),selectionId:id(72),now:at,...args})).toThrow();
    }
  });
  it("requires explicit earlier-material acknowledgment and records it against selection-time inputs",()=>{
    const current=snapshot(contextSnapshotSchema.parse({...context(),description:"Changed brief"}),2);
    const args={actorId:ownerId,projectId,system:system(),currentInput:current,previousSelection:null,identityRevision:0,request:{...selectRequest(),expectedProjectRevision:2},selectionId:id(73),now:at};
    expect(()=>selectIdentitySystem(args)).toThrow();
    const selection=selectIdentitySystem({...args,request:{...args.request,acceptEarlierBasis:true}});
    const freshness=getIdentityFreshness(system().input.basis,{status:"available",basis:current.basis});
    expect(selection.acceptedEarlierBasis).toBe(true);
    expect(identitySelectionWithSystemSchema.safeParse({selection,system:system(),freshness}).success).toBe(true);
    expect(identitySelectionWithSystemSchema.safeParse({selection:{...selection,acceptedEarlierBasis:false},system:system(),freshness}).success).toBe(false);
    expect(identitySelectionWithSystemSchema.safeParse({selection:selected(),system:system(),freshness}).success).toBe(true);
  });
  it("binds stale acknowledgment to every independently versioned input, not only the project/head",()=>{
    const captured=references();
    const changedRefs=createIdentityReferenceSnapshot({...captured,referenceRevision:2,selected:[{...captured.selected[0]!,reaction:{...captured.selected[0]!.reaction,revision:2,elements:["typography"]}}]});
    const inputs=[createIdentityInputSnapshot({...snapshot(),referenceSnapshot:changedRefs}),createIdentityInputSnapshot({...snapshot(),preferencesRevision:1,preferences:{...snapshot().preferences,notes:"A different direction"}})];
    for(const currentInput of inputs){
      const args={actorId:ownerId,projectId,system:system(),currentInput,previousSelection:null,identityRevision:0,request:{...selectRequest(),acceptEarlierBasis:true},selectionId:id(140),now:at};
      expect(()=>selectIdentitySystem(args)).toThrow();
      const fences={expectedReferenceRevision:currentInput.referenceSnapshot.referenceRevision,expectedPreferencesRevision:currentInput.preferencesRevision};
      const selection=selectIdentitySystem({...args,request:{...args.request,...fences}});
      expect(selection).toMatchObject({referenceRevision:fences.expectedReferenceRevision,preferencesRevision:fences.expectedPreferencesRevision,acceptedEarlierBasis:true});
      const refinement={actorId:ownerId,projectId,base:system(),currentInput,previousSelection:selected(),identityRevision:1,request:{...editRequest(),acceptEarlierBasis:true},systemVersionId:id(141),changeId:id(142),selectionId:id(143),now:at};
      expect(()=>refineIdentityComponent(refinement)).toThrow();
      const result=refineIdentityComponent({...refinement,request:{...refinement.request,...fences}});
      expect(result.change).toMatchObject({referenceRevision:fences.expectedReferenceRevision,preferencesRevision:fences.expectedPreferencesRevision});
      expect(result.system.source).toMatchObject({editedAtReferenceRevision:fences.expectedReferenceRevision,editedAtPreferencesRevision:fences.expectedPreferencesRevision});
      expect(()=>selectIdentitySystem({...args,system:result.system,currentInput:snapshot(),request:{...selectRequest(),systemVersionId:result.system.id,acceptEarlierBasis:true}})).toThrow();
    }
    const {expectedReferenceRevision: omittedReference,...withoutReference}=selectRequest();
    const {expectedPreferencesRevision: omittedPreferences,...withoutPreferences}=editRequest();
    expect(omittedReference).toBe(1);expect(omittedPreferences).toBe(0);
    expect(selectIdentitySystemSchema.safeParse(withoutReference).success).toBe(false);
    expect(refineIdentityComponentSchema.safeParse(withoutPreferences).success).toBe(false);
  });
  it("keeps manual edits user-authored, preserves the base basis and marks the inherited board stale",()=>{
    const base=system(),result=edit();
    expect(result.system.source).toMatchObject({kind:"manual_edit",baseSystemVersionId:base.id,changeId:result.change.id,component:"colors",editedAtProjectRevision:1});
    expect(result.change.provenance).toEqual({kind:"user_edit",actorId:ownerId});
    expect(result.system.input).toEqual(base.input);
    expect(result.system.components.logo).toEqual(base.components.logo);
    expect(result.system.components.colors).toEqual(editRequest().input);
    expect(result.system.board).toEqual({...base.board,staleComponents:["colors"]});
    expect(result.system.productionFiles).toEqual(base.productionFiles.filter(file=>file.component!=="colors"));
    expect(result.selection).toMatchObject({systemVersionId:result.system.id,reason:"refined",previousSelectionId:selected().id});
    expect(base).toEqual(system());
    expect(()=>validateIdentityRefinement({base,...result})).not.toThrow();
  });
  it("never silently rebases unchanged components while refining an earlier system",()=>{
    const current=snapshot(contextSnapshotSchema.parse({...context(),description:"Changed brief"}),2);
    const args={actorId:ownerId,projectId,base:system(),currentInput:current,previousSelection:selected(),identityRevision:1,request:{...editRequest(),expectedProjectRevision:2},systemVersionId:id(83),changeId:id(84),selectionId:id(85),now:at};
    expect(()=>refineIdentityComponent(args)).toThrow();
    const result=refineIdentityComponent({...args,request:{...args.request,acceptEarlierBasis:true}});
    expect(result.system.input.basis).toEqual(system().input.basis);
    expect(result.change.projectRevision).toBe(2);
    expect(result.selection.currentBasis).toEqual(current.basis);
    expect(result.selection.acceptedEarlierBasis).toBe(true);
  });
  it("cannot select a manual output before its recorded edit revision or invent a refinement event",()=>{
    const current=snapshot(context(),2);
    const result=refineIdentityComponent({actorId:ownerId,projectId,base:system(),currentInput:current,previousSelection:selected(),identityRevision:1,request:{...editRequest(),expectedProjectRevision:2},systemVersionId:id(86),changeId:id(87),selectionId:id(88),now:at});
    expect(()=>selectIdentitySystem({actorId:ownerId,projectId,system:result.system,currentInput:snapshot(),previousSelection:result.selection,identityRevision:2,request:{...selectRequest(),systemVersionId:result.system.id,expectedIdentityRevision:2},selectionId:id(89),now:at})).toThrow();
    expect(()=>refineIdentityComponent({actorId:ownerId,projectId,base:result.system,currentInput:snapshot(),previousSelection:result.selection,identityRevision:2,request:{...editRequest(),baseSystemVersionId:result.system.id,expectedIdentityRevision:2,input:colors()},systemVersionId:id(94),changeId:id(95),selectionId:id(96),now:at})).toThrow();
    expect(identitySelectionWithSystemSchema.safeParse({selection:{...selected(),reason:"refined"},system:system(),freshness:{status:"current",changed:[]}}).success).toBe(false);
    const later=selectIdentitySystem({actorId:ownerId,projectId,system:system(),currentInput:current,previousSelection:null,identityRevision:0,request:{...selectRequest(),expectedProjectRevision:2},selectionId:id(97),now:at});
    expect(()=>selectIdentitySystem({actorId:ownerId,projectId,system:system(),currentInput:snapshot(),previousSelection:later,identityRevision:1,request:{...selectRequest(),expectedIdentityRevision:1},selectionId:id(98),now:at})).toThrow();
  });
  it("replays before/base/unchanged components instead of accepting a schema-shaped provenance claim",()=>{
    const result=edit(),base=system();
    const changed={...result.system,components:{...result.system.components,logo:{...direction(),direction:"Unrecorded logo edit"}}};
    expect(identitySystemVersionSchema.safeParse(changed).success).toBe(true);
    expect(()=>validateIdentityRefinement({base,...result,system:changed})).toThrow();
    expect(()=>validateIdentityRefinement({base,...result,change:{...result.change,before:{...colors(),usageNotes:"Forged prior state"}}})).toThrow();
    expect(()=>validateIdentityRefinement({base,...result,system:{...result.system,board:{...result.system.board,asset:media(100)}}})).toThrow();
    expect(()=>validateIdentityRefinement({base,...result,system:{...result.system,productionFiles:base.productionFiles}})).toThrow();
    expect(()=>refineIdentityComponent({actorId:ownerId,projectId,base,currentInput:snapshot(),previousSelection:selected(),identityRevision:1,request:{...editRequest(),input:colors()},systemVersionId:id(90),changeId:id(91),selectionId:id(92),now:at})).toThrow();
  });
  it("accepts typed manual intents only and never browser-owned provenance or image operations",()=>{
    expect(refineIdentityComponentSchema.safeParse(editRequest()).success).toBe(true);
    expect(refineIdentityComponentSchema.safeParse({...editRequest(),component:"logo",input:direction()}).success).toBe(false);
    expect(refineIdentityComponentSchema.safeParse({...editRequest(),component:"typography"}).success).toBe(false);
    for(const patch of [{ownerId},{source:{kind:"generated"}},{provider:"openai"},{model:"anything"},{productionFiles:[]},{basis:snapshot().basis}]){
      expect(refineIdentityComponentSchema.safeParse({...editRequest(),...patch}).success).toBe(false);
      expect(selectIdentitySystemSchema.safeParse({...selectRequest(),...patch}).success).toBe(false);
    }
  });
  it("supports successive typography edits without overwriting earlier changes or inventing a rendered board",()=>{
    const first=edit();
    const result=refineIdentityComponent({actorId:ownerId,projectId,base:first.system,currentInput:snapshot(),previousSelection:first.selection,identityRevision:2,
      request:{...editRequest(),baseSystemVersionId:first.system.id,component:"typography",expectedIdentityRevision:2,input:{...typography(),styles:[{...typography().styles[0]!,weight:600}]}},systemVersionId:id(150),changeId:id(151),selectionId:id(152),now:at});
    expect(result.system.components.colors).toEqual(first.system.components.colors);
    expect(result.system.components.typography.styles[0]!.weight).toBe(600);
    expect(result.system.board.staleComponents).toEqual(["colors","typography"]);
    expect(result.system.board.asset).toEqual(system().board.asset);
    expect(()=>validateIdentityRefinement({base:first.system,...result})).not.toThrow();
  });
});

describe("bounded read envelopes without multiplying captured inputs",()=>{
  const overview=()=>{
    const value=system(),currentBasis={status:"available" as const,basis:snapshot().basis};
    return {ownerId,projectId,project:{id:projectId,owner_id:ownerId,title:"Owned brand",scope:"complete_brand",current_revision:1,created_at:at,context:context()},
      session:{ownerId,projectId,identityRevision:1,currentSelectionId:selected().id,currentPreferencesRevision:0,createdAt:at,updatedAt:at},preferences:null,referenceSnapshot:references(),
      readiness:getIdentityReadiness(context(),"complete_brand",{selectedReferenceCount:1}),currentBasis,
      currentSelection:{selection:selected(),system:value,freshness:getIdentityFreshness(value.input.basis,currentBasis)},
      systems:{ownerId,projectId,query:listIdentitySystemsSchema.parse({}),items:[summarizeIdentitySystem(value,currentBasis)],nextCursor:null}};
  };
  it("keeps selection and refinement unavailable when an older response omits its save capability",()=>{
    const value=overview();
    expect(projectIdentityOverviewSchema.parse(value).saveAvailability).toEqual({status:"unavailable",reason:"trusted_transaction_unavailable"});
    expect(projectIdentityOverviewSchema.safeParse({...value,saveAvailability:{status:"available",reason:"provider_ready"}}).success).toBe(false);
    expect(projectIdentityOverviewSchema.safeParse({...value,saveAvailability:{status:"unavailable",reason:"trusted_transaction_unavailable",ownerId}}).success).toBe(false);
  });
  it("uses summaries for history and keeps exact inputs in separately loaded details",()=>{
    const value=overview(),summary=value.systems.items[0]!;
    expect(projectIdentityOverviewSchema.safeParse(value).success).toBe(true);
    expect(summary).not.toHaveProperty("input");expect(summary).not.toHaveProperty("components");
    expect(summary).toMatchObject({inputProjectRevision:1,name:"Cedar",productionFileCount:2});
    expect(identitySystemDetailSchema.safeParse({ownerId,projectId,system:system(),currentBasis:value.currentBasis,freshness:summary.freshness}).success).toBe(true);
    const cursor={projectId,createdAt:at,id:systemId};
    expect(identitySystemPageSchema.safeParse({...value.systems,nextCursor:cursor}).success).toBe(true);
    expect(identitySystemPageSchema.safeParse({...value.systems,nextCursor:{...cursor,projectId:id(99)}}).success).toBe(false);
    expect(listIdentitySystemsSchema.safeParse({limit:51}).success).toBe(false);
    expect(projectIdentityOverviewSchema.safeParse({...value,systems:{...value.systems,items:[{...summary,productionFileCount:0}]}}).success).toBe(false);
  });
  it("rejects replayed or ascending history while preserving fractional and offset ordering",()=>{
    const value=overview(),row=value.systems.items[0]!;
    const cursor={projectId,createdAt:row.createdAt,id:row.id};
    expect(identitySystemPageSchema.safeParse({...value.systems,query:{limit:20,cursor}}).success).toBe(false);
    const newer={...row,id:id(120),createdAt:"2026-10-04T14:00:00.1234567+02:00",board:{...row.board,depictsSystemVersionId:id(120)}};
    const older={...row,id:id(130),createdAt:"2026-10-04T12:00:00.1234566Z",board:{...row.board,depictsSystemVersionId:id(130)}};
    expect(identitySystemPageSchema.safeParse({...value.systems,items:[older,newer]}).success).toBe(false);
    expect(identitySystemPageSchema.safeParse({...value.systems,items:[newer,older]}).success).toBe(true);
    const equivalent={...row,id:id(110),createdAt:"2026-10-04T12:00:00.123456700Z",board:{...row.board,depictsSystemVersionId:id(110)}};
    expect(identitySystemPageSchema.safeParse({...value.systems,items:[newer,equivalent]}).success).toBe(true);
    expect(identitySystemPageSchema.safeParse({...value.systems,items:[equivalent,newer]}).success).toBe(false);
    expect(identitySystemPageSchema.safeParse({...value.systems,query:{limit:20,cursor:{projectId,createdAt:"2026-10-04T12:00:00.1234568Z",id:id(140)}},items:[newer,older]}).success).toBe(true);
  });
  it("keeps saved history visible when current name is missing or inconsistent",()=>{
    for(const patch of [{selectedName:null,intake:{...context().intake,suppliedName:""}},{selectedName:"Elm",intake:context().intake}]){
      const value=overview(),saved=contextSnapshotSchema.parse({...context(),...patch});
      const currentBasis=getIdentityCurrentBasis({ownerId,projectId,context:saved,references:references(),preferences:initialIdentityPreferences(saved)});
      const freshness=getIdentityFreshness(system().input.basis,currentBasis);
      const revised={...value,project:{...value.project,current_revision:2,context:saved},currentBasis,readiness:getIdentityReadiness(saved,"complete_brand",{selectedReferenceCount:1}),
        currentSelection:{...value.currentSelection,freshness},systems:{...value.systems,items:[summarizeIdentitySystem(system(),currentBasis)]}};
      expect(currentBasis.status).toBe("unavailable");expect(freshness.status).toBe("unavailable");
      expect(projectIdentityOverviewSchema.safeParse(revised).success).toBe(true);
      expect(identitySystemDetailSchema.safeParse({ownerId,projectId,system:system(),currentBasis,freshness}).success).toBe(true);
    }
  });
  it("rejects foreign rows, contradictory heads and forged current-basis readiness",()=>{
    const value=overview();
    expect(projectIdentityOverviewSchema.safeParse({...value,ownerId:id(99)}).success).toBe(false);
    expect(projectIdentityOverviewSchema.safeParse({...value,session:{...value.session,identityRevision:2}}).success).toBe(false);
    expect(projectIdentityOverviewSchema.safeParse({...value,currentBasis:{status:"unavailable",reason:"missing_name"}}).success).toBe(false);
    expect(projectIdentityOverviewSchema.safeParse({...value,systems:{...value.systems,items:[...value.systems.items,...value.systems.items]}}).success).toBe(false);
    expect(projectIdentityOverviewSchema.safeParse({...value,readiness:{...value.readiness,ready:false}}).success).toBe(false);
  });
  it("does not report unavailable comparison when the saved current basis is comparable",()=>{
    const value=overview();
    const other=identitySystemVersionSchema.parse({...rawSystem(),id:id(110),board:{...rawSystem().board,depictsSystemVersionId:id(110)}});
    const summary=summarizeIdentitySystem(other,value.currentBasis);
    expect(projectIdentityOverviewSchema.safeParse({...value,systems:{...value.systems,items:[{...summary,freshness:{status:"unavailable",reason:"missing_name"}}]}}).success).toBe(false);
    const renamed={...summary,name:"Elm"};
    expect(projectIdentityOverviewSchema.safeParse({...value,systems:{...value.systems,items:[renamed]}}).success).toBe(false);
    expect(projectIdentityOverviewSchema.safeParse({...value,systems:{...value.systems,items:[{...renamed,freshness:{status:"stale",changed:["name"]}}]}}).success).toBe(true);
  });
  it("uses independent preference CAS and tightly bound neutral mutation envelopes",()=>{
    const value=overview(),preferences={ownerId,projectId,revision:1,preferences:{...snapshot().preferences,notes:"New preference"},createdAt:at};
    const request={expectedPreferencesRevision:0,preferences:preferences.preferences};
    expect(updateIdentityPreferencesSchema.safeParse(request).success).toBe(true);
    expect(updateIdentityPreferencesSchema.safeParse({...request,expectedProjectRevision:1}).success).toBe(false);
    expect(updateIdentityPreferencesSchema.safeParse({...request,ownerId}).success).toBe(false);
    const reply={session:{...value.session,currentPreferencesRevision:1},preferences};
    expect(updateIdentityPreferencesResponseSchema.safeParse(reply).success).toBe(true);
    expect(updateIdentityPreferencesResponseSchema.safeParse({...reply,preferences:{...preferences,revision:2}}).success).toBe(false);
    expect(updateIdentityPreferencesResponseSchema.safeParse({...reply,preferences:{...preferences,projectId:id(99)}}).success).toBe(false);
    const selectionReply={session:value.session,currentSelection:value.currentSelection};
    expect(selectIdentitySystemResponseSchema.safeParse(selectionReply).success).toBe(true);
    expect(selectIdentitySystemResponseSchema.safeParse({...selectionReply,currentSelection:{...value.currentSelection,freshness:{status:"stale",changed:["strategy"]}}}).success).toBe(false);
    expect(selectIdentitySystemResponseSchema.safeParse({...selectionReply,session:{...value.session,currentPreferencesRevision:1}}).success).toBe(false);
  });
});
