export function extractVideoId(url: string): string {
  const parsedUrl = new URL(url);
  if (
    parsedUrl.hostname === 'www.youtube.com' ||
    parsedUrl.hostname === 'youtube.com' ||
    parsedUrl.hostname === 'm.youtube.com'
  ) {
    let res = parsedUrl.searchParams.get('v');
    if (!res) {
      throw new Error('youtube url does not have a `?v=` part: ' + url);
    }
    return res;
  } else if (parsedUrl.hostname === 'youtu.be') {
    let pathParts = parsedUrl.pathname.split('/');
    if (pathParts.length === 2 && pathParts[0] === '') {
      return pathParts[1];
    }
  }
  throw new Error('did not recognize URL ' + url);
}
