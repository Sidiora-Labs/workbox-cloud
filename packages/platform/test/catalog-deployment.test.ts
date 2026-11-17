import { describe, expect, it } from 'vitest';
import type { AppTemplate } from '@repo/core';
import type { ExternalPlanInput } from '@repo/contracts';
import { catalogIdentity, resolveTemplateRecipe } from '../src/engine/modules/apps/catalog-deployment';

const template: AppTemplate = {
  id: 'provider-demo', name: 'Provider Demo', description: 'Test', kind: 'template', logo: 'package', category: 'other',
  available: true, nativeSupport: false, provenance: { source: 'vercel', url: 'https://example.com/template', revision: 'fixed-source' },
  deploymentRecipes: [{ id: 'vercel', label: 'Vercel', provider: 'vercel', workloadKind: 'service',
    source: { repo: 'example/demo', ref: '0123456789012345678901234567890123456789' }, resource: { createProject: 'true' },
    inputs: [{ key: 'apiKey', label: 'API key', type: 'password', target: 'environment', targetKey: 'API_KEY', required: true },
      { key: 'mode', label: 'Mode', type: 'select', target: 'environment', options: [{ value: 'safe', label: 'Safe' }], default: 'safe' }],
  }],
};
const input = (): ExternalPlanInput => ({ target: { provider: 'vercel', workloadKind: 'service', connectionId: 'connection', providerIdentity: {}, resource: { name: 'my-demo' } },
  catalog: { templateId: 'provider-demo', recipeId: 'vercel', config: { apiKey: 'private-secret' } }, idempotencyKey: 'catalog-test-123' });

describe('trusted catalog deployment resolution', () => {
  it('resolves immutable provider source and separates secrets from the public target', () => {
    const resolved = resolveTemplateRecipe(template, input());
    expect(resolved.source).toEqual(template.deploymentRecipes![0]!.source);
    expect(resolved.environment).toEqual({ API_KEY: 'private-secret', mode: 'safe' });
    expect(resolved.target.resource).toMatchObject({ name: 'my-demo', createProject: 'true', appTemplateId: 'provider-demo', appRecipeId: 'vercel' });
    expect(JSON.stringify(resolved.target)).not.toContain('private-secret');
    expect(resolved.catalog).toBeUndefined();
    expect(catalogIdentity(resolved.target.resource)).toMatchObject({ templateId: 'provider-demo', recipeId: 'vercel', name: 'Provider Demo', version: 'fixed-source' });
    expect(resolved.target.resource.appTemplateDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('changes the content digest when the reviewed recipe changes', () => {
    const first = resolveTemplateRecipe(template, input());
    const changed = structuredClone(template); changed.deploymentRecipes![0]!.source = { repo: 'example/other' };
    expect(resolveTemplateRecipe(changed, input()).target.resource.appTemplateDigest).not.toBe(first.target.resource.appTemplateDigest);
  });
  it('rejects unsupported providers and custom template authority', () => {
    expect(() => resolveTemplateRecipe({ ...template, custom: true }, input())).toThrow('not available');
    const wrong = input(); wrong.target.provider = 'fly';
    expect(() => resolveTemplateRecipe(template, wrong)).toThrow('supported deployment recipe');
  });
  it('rejects arbitrary source, environment and selector overrides', () => {
    for (const patch of [{ image: 'untrusted' }, { source: { repo: 'attacker/repo' } }, { environment: { API_KEY: 'injected' } }]) {
      expect(() => resolveTemplateRecipe(template, { ...input(), ...patch })).toThrow('reviewed recipe');
    }
    const spoofed = input(); spoofed.target.resource.appTemplateId = 'forged';
    expect(() => resolveTemplateRecipe(template, spoofed)).toThrow('declared configuration');
  });
  it('validates declared input names, required fields and choices', () => {
    const unknown = input(); unknown.catalog!.config!.undeclared = 'anything';
    expect(() => resolveTemplateRecipe(template, unknown)).toThrow('unknown field');
    const missing = input(); missing.catalog!.config = {};
    expect(() => resolveTemplateRecipe(template, missing)).toThrow('API key is required');
    const choice = input(); choice.catalog!.config!.mode = 'invalid';
    expect(() => resolveTemplateRecipe(template, choice)).toThrow('invalid choice');
  });
  it('rejects a secret input mapped into persisted public selectors', () => {
    const unsafe = structuredClone(template); unsafe.deploymentRecipes![0]!.inputs![0]!.target = 'resource';
    expect(() => resolveTemplateRecipe(unsafe, input())).toThrow('unsafe configuration');
  });
});
