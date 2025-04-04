export async function create(path: string, data: string) {
  try {
    await Deno.writeTextFile(path, data);
  } catch (err) {
    if (err instanceof Deno.errors.AlreadyExists) {
      console.error(
        `File "${path}" not created. It already exists.`,
      );
      return;
    }
    console.error(err);
  }
}
