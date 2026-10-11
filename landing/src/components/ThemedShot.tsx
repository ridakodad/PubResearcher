/**
 * Une capture de l'application en deux versions, claire et sombre : seule celle du thème affiché est visible (et, grâce
 * à `loading="lazy"`, seule celle-là est téléchargée). Les dimensions sont déclarées pour réserver la place avant le
 * chargement — la page ne bouge pas quand l'image arrive.
 */
export function ThemedShot({ name, width, height, alt }: { name: string; width: number; height: number; alt: string }) {
  return (
    <>
      <img className="shot-light" src={`/img/${name}-light.webp`} width={width} height={height} alt={alt} loading="lazy" decoding="async" />
      <img className="shot-dark" src={`/img/${name}-dark.webp`} width={width} height={height} alt={alt} loading="lazy" decoding="async" />
    </>
  );
}
