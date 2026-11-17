import {describe,it,expect} from 'vitest';
import {ENCRYPTED_COLUMNS,stripEncryptedInPlace,topoOrderedTables} from './dump';
describe('managed Workbox host transfer',()=>{
 it('orders host metadata after its server and credential and limits it to whole-instance transfer',()=>{
  const tables=topoOrderedTables();const host=tables.find(t=>t.sqlName==='workbox_host')!;
  expect(host.scopes).toEqual([{in:'instance',via:'all-rows'}]);
  expect(tables.findIndex(t=>t.sqlName==='workbox_host')).toBeGreaterThan(tables.findIndex(t=>t.sqlName==='credential'));
  expect(tables.findIndex(t=>t.sqlName==='workbox_host')).toBeGreaterThan(tables.findIndex(t=>t.sqlName==='servers'));
 });
 it('removes instance-key ciphertext before export',()=>{
  expect(ENCRYPTED_COLUMNS).toContainEqual({table:'workbox_host',column:'tokenEnc'});
  const tables={workbox_host:[{id:'host',tokenEnc:'enc1:private'}]};
  stripEncryptedInPlace(tables);expect(tables.workbox_host[0]?.tokenEnc).not.toBe('enc1:private');
 });
});
