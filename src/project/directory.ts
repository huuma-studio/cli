export async function create(name: string) {
  try {
    await Deno.mkdir(name);
  } catch (err) {
    if (err instanceof Deno.errors.AlreadyExists) {
      console.error(
        `Directory "${name}" not created. It already exists.`,
      );
      return;
    }
    console.error(err);
  }
}
