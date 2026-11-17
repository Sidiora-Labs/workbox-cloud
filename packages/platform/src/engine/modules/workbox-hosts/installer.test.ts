import { describe, it, expect } from "vitest";
import type { CommandExecutor } from "@repo/adapters";
import { hostSteps, installWorkboxHost, privateRequest, probeWorkboxHost, WORKBOX_REVISION, WORKBOX_PORT } from "./installer";
const fake=(override:Partial<CommandExecutor>={})=>({
 exec:async(command:string)=>command==='id -u'?'0':command==='cat /etc/machine-id'?'0123456789abcdef0123456789abcdef':command.includes('doctor --json')?'{"ok":true}':'',
 exists:async()=>false,readFile:async()=>'',writeFile:async()=>{},
 execWithInput:async()=>({code:0,stderr:'',stdout:JSON.stringify({status:200,headers:{},body:Buffer.from('{"sandboxes":[]}').toString('base64')})}),
 ...override,
} as CommandExecutor);
describe('managed Workbox installer',()=>{
 it('rejects incompatible cgroup hosts before installation',async()=>{
  const result=await probeWorkboxHost(fake({exec:async(command)=>{if(command==='id -u')return'0';if(command==='cat /etc/machine-id')return'0123456789abcdef0123456789abcdef';if(command.includes('cgroup.controllers'))throw Error('missing');return'';}}));
  expect(result.accepted).toBe(false);expect(result.checks.find(c=>c.id==='cgroup')?.ok).toBe(false);
 });
 it('rejects unmanaged installation paths rather than adopting them',async()=>{
  const result=await probeWorkboxHost(fake({exists:async()=>true,readFile:async()=>'{"id":"foreign"}'}));
  expect(result.accepted).toBe(false);expect(result.checks.find(c=>c.id==='ownership')?.ok).toBe(false);
 });
 it('pins source, builds rootfs and runtime, and never writes raw key to host configuration or command argv',async()=>{
  const commands:string[]=[];const files:{path:string;content:string}[]=[];const stages:string[]=[];
  const token='private-workbox-credential';
  const executor=fake({exec:async command=>{commands.push(command);return command==='id -u'?'0':command.includes('doctor --json')?'{"ok":true}':'';},writeFile:async(path,content)=>{files.push({path,content});}});
  await installWorkboxHost(executor,{id:'wbhost_1',organizationId:'org_1',identity:'0123456789abcdef0123456789abcdef',rootfs:'agents',token},async id=>{stages.push(id)});
  expect(commands.join('\n')).toContain(WORKBOX_REVISION);expect(commands.join('\n')).toContain('rootfs build minimal');expect(commands.join('\n')).toContain('rootfs build agents');expect(commands.join('\n')).toContain('runtime install');
  expect(commands.join('\n')).not.toContain(token);expect(JSON.stringify(files)).not.toContain(token);expect(files.find(f=>f.path.endsWith('serve.json'))?.content).toContain('tokenSha256');expect(stages).toEqual(hostSteps().filter(s=>s.id!=='connection').map(s=>s.id));
 });
 it('sends auth and body on private stdin and refuses non-loopback destinations',async()=>{
  let argv='';let payload='';const executor=fake({execWithInput:async(command,body)=>{argv=command;for await(const chunk of body)payload+=chunk;return {code:0,stderr:'',stdout:JSON.stringify({status:200,headers:{},body:Buffer.from('{}').toString('base64')})};}});
  await privateRequest(executor,'/v1/sandboxes',{method:'POST',headers:{Authorization:'Bearer private-key'},body:'{"name":"demo"}'});
  expect(argv).not.toContain('private-key');expect(payload).toContain('private-key');expect(payload).toContain(`127.0.0.1:${WORKBOX_PORT}`);
  await expect(privateRequest(executor,'https://attacker.example/',{})).rejects.toThrow('Invalid private Workbox');
 });
 it('does not start daemon when doctor reports isolation failure',async()=>{
  const commands:string[]=[];const executor=fake({exec:async command=>{commands.push(command);return command==='id -u'?'0':command.includes('doctor --json')?'{"ok":false}':'';}});
  await expect(installWorkboxHost(executor,{id:'x',organizationId:'org',identity:'id',rootfs:'minimal',token:'secret'},async()=>{})).rejects.toThrow('doctor');
  expect(commands.some(c=>c.includes('enable --now'))).toBe(false);
 });
 it('elevates private requests on supported non-root SSH connections',async()=>{
   let command='';const executor=fake({exec:async cmd=>cmd==='id -u'?'1000':'',execWithInput:async cmd=>{command=cmd;return {code:0,stderr:'',stdout:JSON.stringify({status:200,headers:{},body:Buffer.from('{}').toString('base64')})};}});
   await privateRequest(executor,'/readyz',{});expect(command).toContain('sudo -n');
 });

});
