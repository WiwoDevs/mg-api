import { readFileSync } from 'node:fs';

/**
 * Catalogo de modelos y concesionarios de MG.
 *
 * Se genera desde los Excel oficiales con scripts/generar-catalogo.py.
 * No editar catalogo.json a mano: se pisa en la proxima generacion.
 */

export type Modelo = {
  serie: string;
  slug: string;
  campoGhl: string | null;
  variantes: string[];
};

export type Concesionario = {
  nombre: string;
  clavePlanilla: string;
  campoGhl: string | null;
  sucursales: string[];
};

type Catalogo = {
  fuentes: string[];
  modelos: Modelo[];
  concesionarios: Concesionario[];
};

const catalogo = JSON.parse(
  readFileSync(new URL('./catalogo.json', import.meta.url), 'utf8'),
) as Catalogo;

/**
 * Deja un texto comparable: sin acentos, sin espacios ni signos, en minusculas.
 * Asi "MG ZS", "mgzs" y "MG-ZS" son el mismo valor.
 */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function indexar<T>(elementos: T[], clave: (elemento: T) => string): Map<string, T> {
  const indice = new Map<string, T>();

  for (const elemento of elementos) {
    const k = normalizar(clave(elemento));

    if (indice.has(k)) {
      throw new Error(`Catalogo invalido: dos entradas comparten la clave "${k}".`);
    }
    indice.set(k, elemento);
  }

  return indice;
}

const modelosPorSerie = indexar(catalogo.modelos, (m) => m.serie);
const concesionariosPorNombre = indexar(catalogo.concesionarios, (c) => c.nombre);

/** Busca una serie por su nombre, tolerando espacios, guiones y mayusculas. */
export function buscarSerie(texto: string): Modelo | undefined {
  return modelosPorSerie.get(normalizar(texto));
}

/**
 * Opciones del formulario que no coinciden con el catalogo.
 *
 * El desplegable ofrece MOVICENTER como si fuera un concesionario, pero es una
 * sucursal de Pompeyo Carrasco. Sin este alias, quien la elige recibe un
 * rechazo y su reclamo no entra. Se retira cuando se corrija el formulario.
 */
const ALIAS_CONCESIONARIO: Record<string, string> = {
  movicenter: 'Pompeyo Carrasco',
};

/** Busca un concesionario por su nombre, con la misma tolerancia. */
export function buscarConcesionario(texto: string): Concesionario | undefined {
  const clave = normalizar(texto);
  const alias = ALIAS_CONCESIONARIO[clave];

  return concesionariosPorNombre.get(alias ? normalizar(alias) : clave);
}

/**
 * Resuelve un valor contra una lista de opciones validas.
 *
 * Primero exige coincidencia exacta. Si no la hay, acepta una coincidencia
 * parcial solo cuando es unica: "XPOWER" resuelve a "MG 4 XPOWER" porque
 * ninguna otra variante de la serie lo contiene. Con dos o mas candidatas
 * devuelve undefined, porque elegir una seria adivinar.
 *
 * @param texto valor recibido
 * @param opciones valores validos
 */
function resolverOpcion(texto: string, opciones: string[]): string | undefined {
  const buscado = normalizar(texto);

  if (!buscado) return undefined;

  const exacta = opciones.find((opcion) => normalizar(opcion) === buscado);

  if (exacta) return exacta;

  const parciales = opciones.filter((opcion) => normalizar(opcion).includes(buscado));

  return parciales.length === 1 ? parciales[0] : undefined;
}

/** Resuelve la variante dentro de una serie. @returns undefined si no existe o es ambigua */
export function buscarVariante(modelo: Modelo, texto: string): string | undefined {
  return resolverOpcion(texto, modelo.variantes);
}

/** Resuelve la sucursal dentro de un concesionario. */
export function buscarSucursal(concesionario: Concesionario, texto: string): string | undefined {
  return resolverOpcion(texto, concesionario.sucursales);
}

/** Nombres de todas las series, para mensajes de error y documentacion. */
export function seriesConocidas(): string[] {
  return catalogo.modelos.map((modelo) => modelo.serie);
}

/** Nombres de todos los concesionarios activos en posventa. */
export function concesionariosConocidos(): string[] {
  return catalogo.concesionarios.map((concesionario) => concesionario.nombre);
}

export { catalogo };
