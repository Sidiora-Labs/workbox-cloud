import { Type, type Static } from "@sinclair/typebox";
const text = Type.String();
export const WorkboxHostSchema = Type.Object({
  id: text, serverId: text, name: text, rootfs: Type.Union([Type.Literal("minimal"), Type.Literal("agents")]), version: text,
  status: Type.Union(["queued","installing","ready","stopped","failed","removing","removed"].map(value => Type.Literal(value))),
  connectionId: Type.Union([text, Type.Null()]),
  progress: Type.Array(Type.Object({id:text,label:text,status:Type.Union(["pending","running","completed","failed"].map(value=>Type.Literal(value))),message:Type.Optional(text)})),
  error: Type.Union([text,Type.Null()]), createdAt:text, updatedAt:text,
});
export type WorkboxHost = Static<typeof WorkboxHostSchema>;
export const WorkboxHostPreflightSchema = Type.Object({accepted:Type.Boolean(),checks:Type.Array(Type.Object({id:text,label:text,ok:Type.Boolean(),detail:text})),blockers:Type.Array(text)});
export type WorkboxHostPreflight = Static<typeof WorkboxHostPreflightSchema>;
export const WorkboxHostPreflightInput = Type.Object({serverId:Type.String({minLength:1})},{additionalProperties:false});
export const WorkboxHostCreateInput = Type.Object({serverId:Type.String({minLength:1}),name:Type.String({minLength:1,maxLength:100}),rootfs:Type.Union([Type.Literal("minimal"),Type.Literal("agents")]),confirm:Type.Literal(true)},{additionalProperties:false});
export const WorkboxHostActionInput = Type.Object({action:Type.Union(["start","stop","retry","remove"].map(value=>Type.Literal(value))),confirm:Type.Optional(Type.Literal(true))},{additionalProperties:false});
export const WorkboxHostOperationSchemas = {
  list:{action:"read",scope:"list",output:Type.Array(WorkboxHostSchema)},
  get:{action:"read",scope:"list",input:Type.Object({id:Type.String({minLength:1})}),output:WorkboxHostSchema},
  preflight:{action:"admin",input:WorkboxHostPreflightInput,output:WorkboxHostPreflightSchema},
  create:{action:"admin",input:WorkboxHostCreateInput,output:WorkboxHostSchema},
  action:{action:"admin",input:Type.Intersect([Type.Object({id:Type.String({minLength:1})}),WorkboxHostActionInput]),output:WorkboxHostSchema},
} as const;
