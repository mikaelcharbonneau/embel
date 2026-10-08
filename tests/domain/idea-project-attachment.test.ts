import { describe, expect, it } from "vitest";
const id = (n: number) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ownerId=id(1), projectId=id(2), at="2026-10-06T12:00:00Z";
import { attachIdeaToProjectInputSchema, ideaProjectAttachmentReceiptSchema, ideaProjectAttachmentPageSchema } from "../../src/domain/idea-project-attachment";
describe("Idea association contracts",()=>{
 it("accepts only exact source/target revisions in browser commands",()=>{const c={requestKey:id(3),ideaId:id(4),expectedIdeaRevision:1,projectId,expectedProjectRevision:2};expect(attachIdeaToProjectInputSchema.safeParse(c).success).toBe(true);expect(attachIdeaToProjectInputSchema.safeParse({...c,source:{content:{title:"Injected"}}}).success).toBe(false);expect(attachIdeaToProjectInputSchema.safeParse({...c,ownerId}).success).toBe(false);});
 it("freezes original Idea content without inventing Strategy approval",()=>{const r={ownerId,requestKey:id(3),association:{id:id(4),ideaId:id(5),ideaRevision:1,projectId,projectRevision:2,createdAt:at},source:{content:{title:"Original",state:"developing"}}};expect(ideaProjectAttachmentReceiptSchema.parse(r).source.content.state).toBe("developing");expect(ideaProjectAttachmentPageSchema.safeParse({ownerId,projectId,items:[r],nextCursor:null}).success).toBe(true);expect(ideaProjectAttachmentPageSchema.safeParse({ownerId:id(99),projectId,items:[r],nextCursor:null}).success).toBe(false);});
});

import { ideaProjectAttachmentOutcomeSchema } from "../../src/domain/idea-project-attachment";
it("binds already-attached requests without relabeling the original receipt or target revision", () => {
 const input = { requestKey: id(20), ideaId: id(4), expectedIdeaRevision: 1, projectId, expectedProjectRevision: 9 };
 const attachment = ideaProjectAttachmentReceiptSchema.parse({ ownerId, requestKey: id(3), association: { id: id(6), ideaId: id(4), ideaRevision: 1, projectId, projectRevision: 2, createdAt: at }, source: { content: { title: "Frozen original" } } });
 const value = { ownerId, requestKey: input.requestKey, status: "already_attached", input, attachment };
 expect(ideaProjectAttachmentOutcomeSchema.parse(value).attachment).toEqual(attachment);
 expect(ideaProjectAttachmentOutcomeSchema.safeParse({ ...value, status: "attached" }).success).toBe(false);
 for (const changed of [ { ...value, requestKey: id(99) }, { ...value, ownerId: id(99) }, { ...value, attachment: { ...attachment, association: { ...attachment.association, ideaRevision: 2 } } }, { ...value, input: { ...input, projectId: id(99) } } ]) expect(ideaProjectAttachmentOutcomeSchema.safeParse(changed).success).toBe(false);
});
