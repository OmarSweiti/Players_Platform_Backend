import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PermissionService } from '../modules/users/application/services/permission.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const permissionService = app.get(PermissionService);

  console.log('Seeding permissions...');
  await permissionService.seedDefaultPermissions();
  console.log('Permissions seeded successfully!');

  await app.close();
}

bootstrap();
