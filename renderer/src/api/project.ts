import axiosReq from '@/utils/axios-req'

export const getMyProjectsReq = (params: any = {}) => axiosReq({ url: '/api/projects', method: 'get', params })
export const getProjectDetailReq = (projectId: any) => axiosReq({ url: `/api/projects/${projectId}`, method: 'get' })
export const createProjectReq = (data: any) => axiosReq({ url: '/api/projects', data, method: 'post' })
export const updateProjectReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}`, data, method: 'put' })
export const deleteProjectReq = (projectId: any) => axiosReq({ url: `/api/projects/${projectId}`, method: 'delete' })

export const getProjectModelsReq = (projectId: any, params: any) =>
  axiosReq({ url: `/api/projects/${projectId}/models`, method: 'get', params })
export const createProjectModelReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}/models`, method: 'post', data })
export const updateProjectModelReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}/models`, method: 'put', data })
export const deleteProjectModelReq = (projectId: any, modelId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/models/${modelId}`, method: 'delete' })
