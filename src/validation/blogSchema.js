const { z } = require("zod");

const ymdRegex = /^\d{4}-\d{2}-\d{2}$/;

const blogPostCreateSchema = z.object({
  title: z.string().trim().min(5, "El titulo debe tener al menos 5 caracteres").max(140),
  category: z.string().trim().min(3, "La categoria es obligatoria").max(60),
  image: z
    .string()
    .trim()
    .min(1, "La imagen es obligatoria")
    .max(500, "La ruta de imagen es demasiado larga")
    .refine(
      (value) => /^https?:\/\//i.test(value) || value.startsWith("/uploads/"),
      "La imagen debe ser una URL valida o una imagen subida al servidor."
    ),
  alt: z.string().trim().min(5, "El texto alternativo es obligatorio").max(180),
  description: z
    .string()
    .trim()
    .min(40, "La descripcion debe tener al menos 40 caracteres")
    .max(4000),
  content: z
    .string()
    .trim()
    .min(80, "El contenido completo debe tener al menos 80 caracteres")
    .max(60000),
  tags: z.string().trim().max(240).optional().default(""),
  date: z
    .string()
    .trim()
    .regex(ymdRegex, "La fecha debe usar formato AAAA-MM-DD")
    .optional(),
});

module.exports = {
  blogPostCreateSchema,
};
