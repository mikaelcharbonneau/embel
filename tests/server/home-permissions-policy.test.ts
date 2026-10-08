import {expect,it} from 'vitest';
import config from '../../next.config';
it('permits only same-origin user-initiated microphone and on-device speech while denying camera and location',async()=>{
 const headers=await config.headers!();const rule=headers.find(row=>row.source==='/(.*)')!;const policy=rule.headers.find(header=>header.key==='Permissions-Policy')!.value;
 expect(policy).toContain('microphone=(self)');expect(policy).toContain('on-device-speech-recognition=(self)');expect(policy).toContain('camera=()');expect(policy).toContain('geolocation=()');expect(policy).not.toContain('*');
});
