import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
export const designKey = (project: string) => ['design', project] as const;
export const useDesign = (project: string) => useQuery({ queryKey: [...designKey(project), 'bundle'], queryFn: () => api.design(project), enabled: !!project, staleTime: 0, refetchInterval: 30_000 });
export const useDesignStale = (project: string) => useQuery({ queryKey: [...designKey(project), 'stale'], queryFn: () => api.designStale(project), enabled: !!project, refetchInterval: 30_000 });
export function useMeasureNow(project: string) {
  const client = useQueryClient();
  return useMutation({ mutationFn: (target: string) => api.designMeasure(project, [target]), onSuccess: () => client.invalidateQueries({ queryKey: designKey(project) }) });
}
