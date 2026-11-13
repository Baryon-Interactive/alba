import { unreal } from './unreal.ts';
import { unity } from './unity.ts';
import { godot } from './godot.ts';
import type { EngineModule } from './types.ts';
export type { EngineModule, EngineResult } from './types.ts';

const modules: EngineModule[] = [unreal, unity, godot];
export const ENGINE_IDS = modules.map(m => m.id);
export const engineModule = (id: string): EngineModule | undefined => modules.find(m => m.id === id);
