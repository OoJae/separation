/**
 * Diagnostics and reporting only. Importing this into a geometry module is a design error:
 * horizontal and vertical separation are SEPARATE standards with separate units, and collapsing
 * them into one euclidean distance is precisely the mistake that would make BRAID-2 incoherent.
 */
export const FT_PER_NM = 6_076.115_485_564_304
