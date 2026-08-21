import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITMO = 'aes-256-gcm';
const LARGO_IV = 12;
const LARGO_TAG = 16;

/**
 * Cifra texto con AES-256-GCM.
 * @param textoPlano contenido a proteger
 * @param clave 32 bytes
 * @returns buffer con el formato iv || tag || texto cifrado
 */
export function cifrar(textoPlano: string, clave: Buffer): Buffer {
  if (clave.length !== 32) throw new Error('La clave de cifrado debe ser de 32 bytes.');

  const iv = randomBytes(LARGO_IV);
  const cifrador = createCipheriv(ALGORITMO, clave, iv);
  const cifrado = Buffer.concat([cifrador.update(textoPlano, 'utf8'), cifrador.final()]);

  return Buffer.concat([iv, cifrador.getAuthTag(), cifrado]);
}

/**
 * Descifra un buffer producido por cifrar().
 * @throws Error si la clave es incorrecta o el contenido fue alterado.
 */
export function descifrar(paquete: Buffer, clave: Buffer): string {
  if (clave.length !== 32) throw new Error('La clave de cifrado debe ser de 32 bytes.');
  if (paquete.length <= LARGO_IV + LARGO_TAG) throw new Error('Paquete cifrado incompleto.');

  const iv = paquete.subarray(0, LARGO_IV);
  const tag = paquete.subarray(LARGO_IV, LARGO_IV + LARGO_TAG);
  const cifrado = paquete.subarray(LARGO_IV + LARGO_TAG);

  const descifrador = createDecipheriv(ALGORITMO, clave, iv);
  descifrador.setAuthTag(tag);

  return Buffer.concat([descifrador.update(cifrado), descifrador.final()]).toString('utf8');
}
