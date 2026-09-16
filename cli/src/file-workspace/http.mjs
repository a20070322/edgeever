// Resource URLs are always constructed from the configured origin and stable ID.
// Never follow a redirect with the workspace bearer token.
export function resourceTransport(baseUrl, token, fetchImpl = fetch) {
  const url = path => new URL(path, baseUrl).toString();
  const headers = { Authorization: `Bearer ${token}` };
  async function check(response) {
    if (!response.ok) {
      const body=await response.json().catch(()=>null);
      throw Object.assign(Error(body?.error?.message || `Attachment HTTP ${response.status}`),{status:response.status});
    }
  }
  return {
    async downloadResource(id, limit) {
      if (!/^[\w-]+$/.test(id)) throw Error('Invalid resource ID');
      const response=await fetchImpl(url(`/api/v1/resources/${id}/blob`),{headers,redirect:'error'});
      await check(response);
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw Error('Attachment too large'); }
      const reader=response.body.getReader(),chunks=[]; let length=0;
      try {
        for (;;) { const {done,value}=await reader.read(); if(done) break; length+=value.length; if(length>limit) throw Error('Attachment too large'); chunks.push(value); }
      } catch(e) { await reader.cancel(); throw e; }
      finally { reader.releaseLock(); }
      return Buffer.concat(chunks,length);
    },
    async uploadResource(memoId, bytes, filename, mimeType) {
      const form=new FormData(); form.append('file',new File([bytes],filename,{type:mimeType}));
      const response=await fetchImpl(url(`/api/v1/memos/${encodeURIComponent(memoId)}/resources`),{method:'POST',headers,body:form,redirect:'error'});
      await check(response); return response.json();
    },
  };
}
