import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { CommandExecutor } from "@repo/adapters";
import { elevatedExecutor } from "@repo/adapters";
import { AppError } from "@repo/core";
import type { WorkboxHost, WorkboxHostPreflight } from "@repo/contracts";

export const WORKBOX_REVISION = "9741e30334139bbe7e28cd5c034e345c616a470a";
export const WORKBOX_NODE_VERSION = "22.23.4";
export const WORKBOX_PORT = 8791;
export const WORKBOX_HOME = "/opt/workbox-cloud-host";
export const WORKBOX_DATA = "/var/lib/workbox-cloud-host";
export const WORKBOX_CONFIG = "/etc/workbox-cloud-host";
export const WORKBOX_UNIT = "workbox-cloud-host.service";
export const hostSteps = (): WorkboxHost["progress"] => [
  ["packages","Install host tools"],["source","Install pinned Workbox"],["prepare","Prepare Linux isolation"],
  ["rootfs","Build sandbox filesystems"],["runtime","Install sandbox runtime"],["doctor","Verify host capabilities"],
  ["daemon","Start private Workbox API"],["connection","Connect Workbox Cloud"],
].map(([id,label])=>({id:id!,label:label!,status:"pending"}));
const q = (value:string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const marker = `${WORKBOX_CONFIG}/owner.json`;

export async function rootExecutor(executor:CommandExecutor):Promise<CommandExecutor> {
  if ((await executor.exec("id -u",{timeout:10_000})).trim()==="0") return executor;
  await executor.exec("sudo -n true",{timeout:10_000});
  return elevatedExecutor(executor);
}

export async function probeWorkboxHost(executor:CommandExecutor, ownedId?:string):Promise<WorkboxHostPreflight & {identity:string}> {
  const checks:WorkboxHostPreflight["checks"]=[];
  const probe=async(id:string,label:string,command:string,detail:string)=>{
    try {await executor.exec(command,{timeout:15_000});checks.push({id,label,ok:true,detail});}
    catch{checks.push({id,label,ok:false,detail:`${label} is unavailable on this server.`});}
  };
  let identity="";
  try{ identity=(await executor.exec("cat /etc/machine-id",{timeout:10_000})).trim(); }catch{}
  checks.push({id:"identity",label:"Persistent machine identity",ok:/^[a-f0-9]{32}$/.test(identity)&&/[1-9a-f]/.test(identity),detail:"The installation remains bound to this physical host."});
  let root:CommandExecutor;
  try{root=await rootExecutor(executor);checks.push({id:"root",label:"Root or passwordless sudo",ok:true,detail:"Host administration is available."});}
  catch{root=executor;checks.push({id:"root",label:"Root or passwordless sudo",ok:false,detail:"Connect as root or configure passwordless sudo before installing."});}
  await probe("linux","Linux kernel", "test \"$(uname -s)\" = Linux && case \"$(uname -m)\" in x86_64|aarch64) true;; *) false;; esac", "64-bit Linux is supported.");
  await probe("apt","Debian or Ubuntu package manager", "command -v apt-get >/dev/null", "The installer supports Debian and Ubuntu hosts.");
  await probe("systemd","Running systemd", "test -d /run/systemd/system && command -v systemctl >/dev/null", "systemd supervises the private daemon.");
  await probe("cgroup","Cgroup v2 controllers", "test -f /sys/fs/cgroup/cgroup.controllers && for c in cpu memory pids; do grep -qw \"$c\" /sys/fs/cgroup/cgroup.controllers || exit 1; done", "CPU, memory and process controllers are available.");
  await probe("userns","User namespaces", "test ! -f /proc/sys/user/max_user_namespaces || test \"$(cat /proc/sys/user/max_user_namespaces)\" -gt 0", "The kernel allows user namespaces.");
  await probe("disk","At least 8 GiB free", "test \"$(df -Pk /var/lib | awk 'NR==2 {print $4}')\" -ge 8388608", "Filesystem and runtime builds have working space.");
  try {
    const exists=await root.exists(marker);
    if(exists){const owner=JSON.parse(await root.readFile(marker));if(owner.id!==ownedId)throw Error();}
    else {await root.exec(`test ! -e ${q(WORKBOX_HOME)} && test ! -e ${q(WORKBOX_DATA)} && test ! -e ${q(WORKBOX_CONFIG)} && test ! -e /etc/systemd/system/${WORKBOX_UNIT}`,{timeout:10_000});}
    checks.push({id:"ownership",label:"Dedicated installation paths",ok:true,detail:"Existing unmanaged Workbox installations will not be overwritten."});
  } catch {checks.push({id:"ownership",label:"Dedicated installation paths",ok:false,detail:"Dedicated Workbox Cloud paths already exist without this installation's ownership marker."});}
  try {
    await root.exec(`! ss -ltn | awk '{print $4}' | grep -Eq '(^|:)${WORKBOX_PORT}$'${ownedId?` || test -f ${q(marker)}`:""}`,{timeout:10_000});
    checks.push({id:"port",label:"Private API port",ok:true,detail:`Loopback port ${WORKBOX_PORT} is available or owned by this installation.`});
  }catch{checks.push({id:"port",label:"Private API port",ok:false,detail:`Loopback port ${WORKBOX_PORT} is already in use.`});}
  return {accepted:checks.every(c=>c.ok),checks,blockers:checks.filter(c=>!c.ok).map(c=>c.detail),identity};
}

/** Token bytes travel only through the executor's stdin channel, never shell argv or logs. */
export async function privateRequest(executor:CommandExecutor,path:string,options:{method?:string;headers?:Record<string,string>;body?:string;timeoutMs?:number;maxBodyBytes?:number}) {
  if(!executor.execWithInput)throw new AppError("This server connection cannot carry private API requests.",409,"WORKBOX_TRANSPORT_UNAVAILABLE");
  const url=new URL(path,`http://127.0.0.1:${WORKBOX_PORT}`);
  if(url.origin!==`http://127.0.0.1:${WORKBOX_PORT}`||!url.pathname.startsWith("/"))throw new AppError("Invalid private Workbox API path",400,"WORKBOX_PATH_INVALID");
  const source=`let s='';for await(const c of process.stdin)s+=c;const p=JSON.parse(s);const r=await fetch(p.url,{method:p.method,headers:p.headers,body:p.body,redirect:'manual',signal:AbortSignal.timeout(p.timeout)});const chunks=[];let n=0;for await(const c of r.body??[]){n+=c.length;if(n>p.limit)throw Error('RESPONSE_TOO_LARGE');chunks.push(c)}console.log(JSON.stringify({status:r.status,headers:Object.fromEntries(r.headers),body:Buffer.concat(chunks).toString('base64')}));`;
  const payload=JSON.stringify({url:url.href,method:options.method??"GET",headers:options.headers,body:options.body,timeout:Math.min(options.timeoutMs??15_000,120_000),limit:Math.min(options.maxBodyBytes??8*1024*1024,8*1024*1024)});
  const privileged=await rootExecutor(executor);
  if(!privileged.execWithInput)throw new AppError("This server connection cannot carry private API requests.",409,"WORKBOX_TRANSPORT_UNAVAILABLE");
  const result=await privileged.execWithInput(`${q(WORKBOX_HOME+"/node/bin/node")} --input-type=module -e ${q(source)}`,Readable.from([payload]));
  if(result.code!==0)throw new AppError("Private Workbox API request failed. Check its host status.",502,"WORKBOX_HOST_UNAVAILABLE");
  try{const row=JSON.parse(result.stdout);const buffer=Buffer.from(row.body,"base64");return {status:Number(row.status),ok:row.status>=200&&row.status<300,headers:row.headers,text:async()=>buffer.toString(),json:async()=>JSON.parse(buffer.toString()),bytes:async()=>buffer};}
  catch{throw new AppError("Invalid private Workbox response",502,"WORKBOX_RESPONSE_INVALID");}
}

export async function installWorkboxHost(executor:CommandExecutor,input:{id:string;organizationId:string;identity:string;rootfs:"minimal"|"agents";token:string},step:(id:string,message:string)=>Promise<void>) {
  const root=await rootExecutor(executor);
  const ownership={id:input.id,organizationId:input.organizationId,identity:input.identity,revision:WORKBOX_REVISION};
  const run=async(command:string,timeout=20*60_000)=>{await root.exec(command,{timeout});};
  await step("packages","Installing isolated host prerequisites.");
  await run("export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y --no-install-recommends bubblewrap util-linux slirp4netns nftables uidmap iproute2 tar xz-utils ca-certificates git curl docker.io make g++ python3");
  await run(`install -d -m 700 ${q(WORKBOX_CONFIG)} ${q(WORKBOX_HOME)}`);
  await root.writeFile(marker,JSON.stringify(ownership),{mode:0o600});
  await step("source","Installing a pinned Workbox revision and Node runtime.");
  await run(`set -eu; cd ${q(WORKBOX_HOME)}; case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; esac; file=node-v${WORKBOX_NODE_VERSION}-linux-$arch.tar.xz; if [ ! -x node/bin/node ]; then curl -fsSLo "$file" "https://nodejs.org/dist/v${WORKBOX_NODE_VERSION}/$file"; curl -fsSLo SHASUMS256.txt "https://nodejs.org/dist/v${WORKBOX_NODE_VERSION}/SHASUMS256.txt"; grep " $file$" SHASUMS256.txt | sha256sum -c -; tar -xf "$file"; mv "node-v${WORKBOX_NODE_VERSION}-linux-$arch" node; rm "$file" SHASUMS256.txt; fi; if [ ! -d source/.git ]; then git init -q source; git -C source remote add origin https://github.com/Sidiora-Labs/workbox.git; fi; git -C source fetch --depth 1 origin ${WORKBOX_REVISION}; git -C source checkout --detach ${WORKBOX_REVISION}; test "$(git -C source rev-parse HEAD)" = ${WORKBOX_REVISION}; export PATH=${q(WORKBOX_HOME+"/node/bin")}:"$PATH"; cd source; corepack enable; corepack pnpm install --frozen-lockfile`);
  await step("prepare","Preparing cgroup delegation and subordinate user IDs.");
  // Overlapping mappings are a blocker, not a warning that an unattended installer ignores.
  await run(`set -eu; for file in /etc/subuid /etc/subgid; do if [ -f "$file" ]; then awk -F: '$1 != "root" && $1 != "0" && $2 < 365536 && $2+$3 > 300000 {exit 1}' "$file"; fi; done; sh ${q(WORKBOX_HOME+"/source/deploy/install.sh")} --root ${q(WORKBOX_DATA)} --etc ${q(WORKBOX_CONFIG)} --cgroup-parent workbox-cloud-host; systemctl start docker`);
  const cli=`env PATH=${q(WORKBOX_HOME+"/node/bin")}:"$PATH" WORKBOX_ROOT=${q(WORKBOX_DATA)} WORKBOX_CGROUP_PARENT=workbox-cloud-host WORKBOX_ROOTFS=${q(input.rootfs)} ${q(WORKBOX_HOME+"/node/bin/node")} ${q(WORKBOX_HOME+"/source/packages/cli/src/main.js")}`;
  await step("rootfs","Building the shared sandbox filesystem.");
  await run(`${cli} rootfs build minimal`);
  if(input.rootfs==="agents")await run(`${cli} rootfs build agents`);
  await step("runtime","Installing the sandbox runtime.");
  await run(`${cli} runtime install`);
  await step("doctor","Verifying actual isolation and prepared assets.");
  const doctor = JSON.parse(await root.exec(`${cli} doctor --json`,{timeout:120_000}));
  if (doctor.ok !== true) throw new AppError("Workbox doctor found unsupported host capabilities. Check the host before retrying.",409,"WORKBOX_HOST_UNSUPPORTED");
  await step("daemon","Starting the private authenticated daemon.");
  await root.writeFile(`${WORKBOX_CONFIG}/serve.json`,JSON.stringify({host:"127.0.0.1",port:WORKBOX_PORT,serverNames:["127.0.0.1","localhost"],keys:[{id:"workbox-cloud",tokenSha256:createHash("sha256").update(input.token).digest("hex"),scopes:["read","exec","admin"]}]}),{mode:0o600});
  const unit=`[Unit]\nDescription=Workbox Cloud managed sandbox host\nAfter=network.target docker.service\n[Service]\nType=simple\nUser=root\nEnvironment=WORKBOX_ROOT=${WORKBOX_DATA}\nEnvironment=WORKBOX_CGROUP_PARENT=workbox-cloud-host\nEnvironment=WORKBOX_ROOTFS=${input.rootfs}\nEnvironment=PATH=${WORKBOX_HOME}/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nExecStart=${WORKBOX_HOME}/node/bin/node ${WORKBOX_HOME}/source/packages/cli/src/main.js serve --config ${WORKBOX_CONFIG}/serve.json\nRestart=on-failure\nRestartSec=2\nLimitNOFILE=65536\nProtectSystem=full\nPrivateTmp=yes\nNoNewPrivileges=yes\n[Install]\nWantedBy=multi-user.target\n`;
  await root.writeFile(`/etc/systemd/system/${WORKBOX_UNIT}`,unit,{mode:0o644});
  await run(`systemctl daemon-reload && systemctl enable --now ${WORKBOX_UNIT}`,60_000);
  for(let attempt=0;attempt<20;attempt++){
    try{const ready=await privateRequest(executor,"/readyz",{});const inventory=await privateRequest(executor,"/v1/sandboxes",{headers:{Authorization:`Bearer ${input.token}`}});if(ready.ok&&inventory.ok)return;}
    catch{ /* The daemon may still be starting. Only fixed status reaches progress logs. */ }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  throw new AppError("The installed Workbox daemon did not become ready.",502,"WORKBOX_HOST_NOT_READY");
}
