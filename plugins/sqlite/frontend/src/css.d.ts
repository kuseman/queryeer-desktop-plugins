// esbuild loads .css as text (--loader:.css=text); the plugin injects it as a <style> element.
declare module "*.css" {
  const content: string;
  export default content;
}
