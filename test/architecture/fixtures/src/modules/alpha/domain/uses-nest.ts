// Breaks domain-is-framework-free: the domain imports the framework.
import { Injectable } from '@nestjs/common';

export const decorated = Injectable;
