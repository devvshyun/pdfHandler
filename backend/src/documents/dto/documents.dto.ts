import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { PdfOperation } from '@pdfhandler/core';

export class ListDocumentsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit = 20;

  @IsOptional() @IsString() @MaxLength(100)
  q?: string;
}

export class UploadDocumentBody {
  @IsOptional() @IsString() @MaxLength(255)
  title?: string;
}

export class UploadVersionBody {
  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

export class ApplyOperationsBody {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsObject({ each: true })
  operations!: PdfOperation[];

  @IsOptional() @IsString() @MaxLength(500)
  note?: string;
}

export class UpdateDocumentBody {
  @IsString() @MaxLength(255)
  title!: string;
}
