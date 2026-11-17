import {describe,it,expect,vi} from "vitest";
import {createAuthorization} from "../src/authorization";
import {createWorkboxHostOperations} from "../src/workbox-hosts";
import {alice,authorizationFixture} from "./fixtures";
describe('Workbox host operation authorization',()=>{
 it.each([['preflight',{serverId:'server-a'}],['create',{serverId:'server-a',name:'Host',rootfs:'minimal',confirm:true}],['action',{id:'host-a',action:'remove',confirm:true}]] as const)('rejects readonly credentials before %s can execute',async(name,input)=>{
  const fixture=authorizationFixture();fixture.members.set('org-a:alice',{id:'member',role:'owner'});const auth=createAuthorization(fixture);
  const ctx=await auth.resolveScope({...alice,credential:{organizationId:'org-a',readOnly:true}},'org-a');const service=vi.fn();const operations=createWorkboxHostOperations(auth,{[name]:service} as never);
  await expect(operations[name](ctx,input as never)).rejects.toMatchObject({code:'TOKEN_READ_ONLY'});expect(service).not.toHaveBeenCalled();
 });
});
