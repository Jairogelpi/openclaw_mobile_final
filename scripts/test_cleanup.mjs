import fs from 'fs';
import { FormData, Blob } from 'formdata-node';
import fetch from 'node-fetch';

async function testCleanup() {
    console.log('--- Iniciando prueba de limpieza de media ---');
    
    // 1. Crear un archivo de prueba
    const filePath = './test_upload.txt';
    fs.writeFileSync(filePath, 'Contenido de prueba para verificar borrado');
    
    const form = new FormData();
    const stats = fs.statSync(filePath);
    const fileStream = fs.createReadStream(filePath);
    
    // Usamos el endpoint de análisis de archivos que es más genérico
    const url = 'http://localhost:3000/api/media/analyze-file';
    
    try {
        console.log('Enviando archivo a:', url);
        
        // Simular multipart/form-data
        // Nota: node-fetch y formdata-node pueden ser un poco especiales con streams
        // Para simplificar usaremos un Buffer
        const buffer = fs.readFileSync(filePath);
        const file = new Blob([buffer], { type: 'text/plain' });
        form.set('file', file, 'test_upload.txt');

        const response = await fetch(url, {
            method: 'POST',
            body: form
        });

        const result = await response.json();
        console.log('Respuesta del servidor:', result);

        // 2. Comprobar la carpeta uploads
        setTimeout(() => {
            const files = fs.readdirSync('./uploads');
            console.log('Archivos en /uploads después de la prueba:', files);
            if (files.length === 0) {
                console.log('✅ ÉXITO: La carpeta /uploads está vacía.');
            } else {
                console.warn('⚠️ ADVERTENCIA: Hay archivos en /uploads:', files);
            }
            
            // Limpiar el archivo local de prueba
            fs.unlinkSync(filePath);
        }, 1000);

    } catch (err) {
        console.error('❌ Error durante la prueba:', err.message);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
}

testCleanup();
