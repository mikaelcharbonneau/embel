import {expect,it} from 'vitest';
import {jobActivityHref,jobOperationLabel} from '@/domain/job-activity';
import {operationSchema} from '@/domain/providers';
const projectId='d0000000-0000-4000-8000-000000000001';
it.each([['identity.logo_concept','/logo'],['identity.logo_refine','/logo'],['identity.logo_vectorize','/logo/editor'],['identity.logo_directions','/logo/directions'],['identity.logo_export','/logo/deliverables']] as const)('links %s to its exact saved output', (operation,suffix)=>{expect(jobActivityHref({projectId,operation})).toBe(`/brands/account/${projectId}${suffix}`);});
it('labels every supported operation',()=>{for(const operation of operationSchema.options)expect(jobOperationLabel(operation).length).toBeGreaterThan(0);});
