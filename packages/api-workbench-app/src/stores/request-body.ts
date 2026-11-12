import { defineStore } from 'pinia';
import * as payload from '@techieutils/api-workbench-common/request-payload';
import { markRaw } from 'vue';
import type {
  ApiRequest,
  BodyType,
  RequestPayload,
  UploadData,
} from '@techieutils/api-workbench-common/types';
import { useWorkspaceStore } from './workspace';

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const RAW_CONTENT_TYPES: [string, string][] = [
  ['JSON', 'application/json'],
  ['Text', 'text/plain'],
  ['XML', 'application/xml'],
  ['HTML', 'text/html'],
  ['JavaScript', 'application/javascript'],
  ['TypeScript', 'application/typescript'],
  ['CSS', 'text/css'],
  ['Markdown', 'text/markdown'],
  ['SQL', 'application/sql'],
  ['GraphQL', 'application/graphql'],
  ['CSV', 'text/csv'],
  ['YAML', 'application/yaml'],
  ['JSON:API', 'application/vnd.api+json'],
  ['NDJSON', 'application/x-ndjson'],
  ['Custom', 'custom'],
];

/** Request bodies: the files chosen for uploads, and the body sent for each body type. */
export const useRequestBodyStore = defineStore('requestBody', () => {
  /**
   * Chosen files by request id (binary bodies) or field file id (form data). Kept for this
   * session only and never persisted; raw, as it is read when sending rather than rendered.
   */
  const uploads = markRaw(new Map<string, UploadData>());

  const bodyType = (request: ApiRequest): BodyType => request.bodyType || 'raw';
  async function readUpload(file: File): Promise<UploadData> {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('Choose a file smaller than 20 MB.');
    const base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('The file could not be read.'));
      reader.readAsDataURL(file);
    });
    return { name: file.name, type: file.type, base64 };
  }
  /** The body to send, setting or clearing the Content-Type header in `headers` to match. */
  const prepareBody = (
    request: ApiRequest,
    headers: Record<string, string>,
  ): Pick<RequestPayload, 'body' | 'multipart' | 'binary'> =>
    payload.prepareBody(request, headers, useWorkspaceStore().resolve, (id) => uploads.get(id));
  return { uploads, rawContentTypes: RAW_CONTENT_TYPES, bodyType, readUpload, prepareBody };
});
